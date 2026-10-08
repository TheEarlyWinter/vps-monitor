import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const ROOT = path.resolve(import.meta.dirname, '../..');
const SERVICE = path.join(ROOT, 'runtime/ssh-service.mjs');

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startSshServer() {
  const hostKey = utils.generateKeyPairSync('ed25519');
  let closeRequested = false;
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    // TOFU deliberately closes immediately after receiving the host key; the
    // server can report that expected probe disconnect as KEY_EXCHANGE_FAILED.
    client.on('error', () => undefined);
    client.on('authentication', (context) => context.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptCommand, _reject, info) => {
          if (info.command === 'HANG') return;
          const stream = acceptCommand();
          stream.exit(0);
          stream.end('VMON/1\n@@end\n');
        });
      });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('SSH server did not expose a port'));
      resolve(address.port);
    });
  });

  return {
    port,
    async close() {
      if (closeRequested) return;
      closeRequested = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function startSidecar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-sidecar-integration-'));
  const rpcPort = await freePort();
  const secret = randomBytes(32).toString('hex');
  const configPath = path.join(dir, 'runtime.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: rpcPort, secret }), { mode: 0o600 });
  const child = spawn(process.execPath, [SERVICE, configPath], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sidecar did not become ready: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('VPS_SSH_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (code !== null && !output.includes('VPS_SSH_READY')) {
        clearTimeout(timer);
        reject(new Error(`Sidecar exited before ready (${code}): ${output}`));
      }
    });
  });
  await ready;

  return {
    port: rpcPort,
    secret,
    child,
    async rpc(method: string, payload: Record<string, unknown>) {
      const response = await fetch(`http://127.0.0.1:${rpcPort}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${secret}`
        },
        body: JSON.stringify({ method, payload })
      });
      return { response, body: await response.json() as any };
    },
    async close() {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
          resolve();
        }, 2000);
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('managed SSH sidecar performs TOFU, authenticated exec, and hard exec timeout', async () => {
  const sshServer = await startSshServer();
  const sidecar = await startSidecar();
  const connectionId = 'integration-connection';
  try {
    const probe = await sidecar.rpc('connect', {
      connectionId,
      host: '127.0.0.1',
      port: sshServer.port,
      username: 'root',
      verifyHostKeyOnly: true,
      expectedHostKeyPin: null,
      timeoutMs: 3000
    });
    assert.equal(probe.response.ok, true);
    assert.equal(probe.body.ok, true);
    assert.equal(probe.body.value.pinMatched, false);
    assert.match(probe.body.value.actualHostKey.fingerprintSha256, /^SHA256:/);

    const disconnectProbe = await sidecar.rpc('disconnect', { connectionId });
    assert.equal(disconnectProbe.body.ok, true);

    const connect = await sidecar.rpc('connect', {
      connectionId,
      host: '127.0.0.1',
      port: sshServer.port,
      username: 'root',
      auth: { kind: 'password', secret: 'integration-only' },
      verifyHostKeyOnly: false,
      expectedHostKeyPin: probe.body.value.actualHostKey,
      timeoutMs: 3000
    });
    assert.equal(connect.body.ok, true);
    assert.equal(connect.body.value.pinMatched, true);

    const exec = await sidecar.rpc('exec', {
      connectionId,
      command: 'VMON/1',
      timeoutMs: 1000
    });
    assert.equal(exec.body.ok, true);
    assert.equal(exec.body.value.stdout, 'VMON/1\n@@end\n');

    const startedAt = Date.now();
    const hangingExec = await sidecar.rpc('exec', {
      connectionId,
      command: 'HANG',
      timeoutMs: 300
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(hangingExec.response.ok, false);
    assert.equal(hangingExec.body.error.code, 'SAMPLE_TIMEOUT');
    assert.ok(elapsedMs < 2500, `exec timeout took ${elapsedMs}ms`);
  } finally {
    await sidecar.rpc('disconnect', { connectionId }).catch(() => undefined);
    await sidecar.close();
    await sshServer.close();
  }
});

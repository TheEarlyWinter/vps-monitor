import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HanaSshTransport } from '../../src/collector/runtime-ssh-transport.ts';
import { ErrorCodes, VpsMonitorError } from '../../src/types/index.ts';

const hostKey = {
  algorithm: 'ssh-ed25519',
  publicKeyBlob: 'AQID',
  fingerprintSha256: 'SHA256:abc',
  confirmedAt: new Date().toISOString()
};

function makeRuntime(options: {
  startError?: Error & { code?: string };
  connectResult?: unknown;
} = {}) {
  const calls: Array<{ method: string; payload: any }> = [];
  const starts: Array<Record<string, unknown>> = [];
  let stopped = false;
  const runtime = {
    async start(input: Record<string, unknown>) {
      starts.push(input);
      if (options.startError) throw options.startError;
      return { runtimeId: 'runtime-1' };
    },
    async get() {
      return { state: 'ready', service: { state: 'ready' } };
    },
    async fetch(_runtimeId: string, _path: string, init: any) {
      const body = JSON.parse(init.body);
      calls.push(body);
      let value: unknown = { ready: true };
      if (body.method === 'connect') value = options.connectResult ?? { actualHostKey: hostKey, pinMatched: true };
      if (body.method === 'exec') value = { stdout: 'VMON/1\n@@end\n', stderr: '', exitCode: 0, durationMs: 1 };
      return new Response(JSON.stringify({ ok: true, value }), { status: 200 });
    },
    async stop() {
      stopped = true;
      return { state: 'stopped' };
    },
    calls,
    starts,
    get stopped() { return stopped; }
  };
  return runtime;
}

function configDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vps-runtime-transport-'));
}

test('HanaSshTransport: starts managed runtime, proxies RPC, and stops it on disconnect', async () => {
  const dir = configDir();
  const runtime = makeRuntime();
  const transport = new HanaSshTransport(runtime, dir);
  try {
    const connected = await transport.connect({
      host: 'example.com',
      port: 22,
      username: 'root',
      auth: { kind: 'password', secret: 'not-logged' },
      expectedHostKeyPin: hostKey,
      verifyHostKeyOnly: false,
      timeoutMs: 1000
    });
    assert.equal(connected.pinMatched, true);
    assert.equal(transport.isConnected(), true);
    const service = runtime.starts[0]?.service as { id?: string };
    assert.match(service?.id ?? '', /^ssh-[0-9a-f-]+$/);
    assert.notEqual(service?.id, 'ssh');

    const result = await transport.exec('printf test', 1000);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /VMON\/1/);
    assert.equal(runtime.calls.some(call => call.method === 'exec'), true);

    await transport.disconnect();
    assert.equal(transport.isConnected(), false);
    assert.equal(runtime.stopped, true);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HanaSshTransport: external runtime denial maps to PERMISSION_REQUIRED', async () => {
  const dir = configDir();
  const error = Object.assign(new Error('external network denied'), { code: 'RUNTIME_PERMISSION_DENIED' });
  const runtime = makeRuntime({ startError: error });
  const transport = new HanaSshTransport(runtime, dir);
  try {
    await assert.rejects(
      transport.connect({
        host: 'example.com',
        port: 22,
        username: 'root',
        expectedHostKeyPin: null,
        verifyHostKeyOnly: true,
        timeoutMs: 1000
      }),
      (actual: unknown) => actual instanceof VpsMonitorError && actual.code === ErrorCodes.PERMISSION_REQUIRED
    );
    assert.equal(transport.isConnected(), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

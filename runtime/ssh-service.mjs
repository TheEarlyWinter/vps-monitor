import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import ssh2 from 'ssh2';

const { Client, utils } = ssh2;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_EXEC_TIMEOUT_MS = 8_000;
const MAX_CONNECT_TIMEOUT_MS = 30_000;
const MAX_EXEC_TIMEOUT_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_HOST = /^[A-Za-z0-9._:[\]-]+$/;

const configFile = process.argv[2];
if (typeof configFile !== 'string' || !path.isAbsolute(configFile)) {
  throw new Error('Invalid runtime configuration path');
}

const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
if (
  !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
  typeof config.secret !== 'string' || !/^[a-f0-9]{64}$/.test(config.secret)
) {
  throw new Error('Invalid runtime configuration');
}
try { fs.rmSync(configFile, { force: true }); } catch {}

const connections = new Map();
let stopping = false;

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw rpcError('INVALID_INPUT', `Invalid ${field}`);
  }
  return value;
}

function assertHost(value) {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 255 ||
    !SAFE_HOST.test(value) || value.includes('..') ||
    value.startsWith('.') || value.endsWith('.')
  ) {
    throw rpcError('INVALID_INPUT', 'Invalid SSH host');
  }
  return value;
}

function assertPort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw rpcError('INVALID_INPUT', 'Invalid SSH port');
  }
  return value;
}

function assertUsername(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\u0000\r\n]/.test(value)) {
    throw rpcError('INVALID_INPUT', 'Invalid SSH username');
  }
  return value;
}

function assertTimeout(value, fallback, max) {
  const timeout = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > max) {
    throw rpcError('INVALID_INPUT', 'Invalid timeout');
  }
  return timeout;
}

function normalizeHostKey(key) {
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error || !parsed || typeof parsed.type !== 'string' || typeof parsed.getPublicSSH !== 'function') {
    throw rpcError('HOST_KEY_UNSUPPORTED', 'Unsupported SSH host-key format');
  }
  const publicKey = parsed.getPublicSSH();
  const fingerprint = createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
  return {
    algorithm: parsed.type,
    publicKeyBlob: Buffer.from(publicKey).toString('base64'),
    fingerprintSha256: `SHA256:${fingerprint}`,
    confirmedAt: new Date().toISOString(),
  };
}

function hostKeyMatches(actual, expected) {
  return Boolean(
    expected &&
    actual.algorithm === expected.algorithm &&
    actual.publicKeyBlob === expected.publicKeyBlob &&
    actual.fingerprintSha256 === expected.fingerprintSha256
  );
}

function safeBearerEqual(received) {
  if (typeof received !== 'string') return false;
  const expected = Buffer.from(`Bearer ${config.secret}`);
  const actual = Buffer.from(received);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseAuth(input) {
  if (input === undefined || input === null) return null;
  if (!input || typeof input !== 'object' || (input.kind !== 'password' && input.kind !== 'privateKey')) {
    throw rpcError('UNSUPPORTED_AUTH', 'Unsupported SSH authentication');
  }
  if (typeof input.secret !== 'string' || input.secret.length < 1 || input.secret.length > 1024 * 1024) {
    throw rpcError('INVALID_INPUT', 'Invalid SSH credential');
  }
  if (input.passphrase !== undefined && (typeof input.passphrase !== 'string' || input.passphrase.length > 4096)) {
    throw rpcError('INVALID_INPUT', 'Invalid SSH passphrase');
  }
  return { kind: input.kind, secret: input.secret, passphrase: input.passphrase };
}

function makeClientConfig(payload, hostVerifier) {
  const host = assertHost(payload.host);
  const port = assertPort(payload.port);
  const username = assertUsername(payload.username);
  const timeoutMs = assertTimeout(payload.timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, MAX_CONNECT_TIMEOUT_MS);
  const auth = parseAuth(payload.auth);
  const config = {
    host,
    port,
    username,
    hostVerifier,
    readyTimeout: timeoutMs,
    keepaliveInterval: 30_000,
    keepaliveCountMax: 3,
    tryKeyboard: false,
    agentForward: false,
    strictVendor: true,
  };
  if (auth?.kind === 'password') {
    config.password = auth.secret;
    config.authHandler = ['password'];
  } else if (auth?.kind === 'privateKey') {
    config.privateKey = Buffer.from(auth.secret, 'utf8');
    if (auth.passphrase !== undefined) config.passphrase = auth.passphrase;
    config.authHandler = ['publickey'];
  } else {
    // Host-key inspection must stop before authentication starts.
    config.authHandler = ['none'];
  }
  return { config, timeoutMs };
}

function connectSession(payload) {
  const connectionId = assertId(payload.connectionId, 'connectionId');
  if (connections.has(connectionId)) {
    return Promise.reject(rpcError('INVALID_STATE', 'Connection already exists'));
  }

  const verifyHostKeyOnly = payload.verifyHostKeyOnly === true;
  const expectedHostKeyPin = payload.expectedHostKeyPin ?? null;
  if (expectedHostKeyPin !== null && typeof expectedHostKeyPin !== 'object') {
    return Promise.reject(rpcError('INVALID_INPUT', 'Invalid expected host key'));
  }

  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let actualHostKey = null;
    let pinMatched = false;
    let verifyOnlyResolved = false;
    let connectTimer = null;

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      reject(error);
    };
    const closeProbe = () => {
      try { client.end(); } catch {}
    };

    const hostVerifier = (key) => {
      try {
        actualHostKey = normalizeHostKey(key);
        pinMatched = expectedHostKeyPin !== null && hostKeyMatches(actualHostKey, expectedHostKeyPin);
        if (verifyHostKeyOnly || expectedHostKeyPin === null || !pinMatched) {
          // ssh2 emits `Host denied (verification failed)` immediately after a
          // verifier returns false. Resolve before returning so that the
          // caller receives the real candidate key instead of a generic error.
          verifyOnlyResolved = true;
          finishResolve({ actualHostKey, pinMatched: false });
          queueMicrotask(closeProbe);
          return false;
        }
        return true;
      } catch (error) {
        finishReject(error);
        return false;
      }
    };

    client.once('ready', () => {
      if (verifyOnlyResolved) return;
      if (!actualHostKey || !pinMatched) {
        finishReject(rpcError('HOST_KEY_CHANGED', 'SSH host key verification failed'));
        closeProbe();
        return;
      }
      connections.set(connectionId, { client, hostKey: actualHostKey });
      finishResolve({ actualHostKey, pinMatched: true });
    });

    client.once('timeout', () => finishReject(rpcError('CONNECT_TIMEOUT', 'SSH connection timed out')));
    client.once('error', (error) => {
      if (settled) return;
      const message = typeof error?.message === 'string' ? error.message : 'SSH connection failed';
      const code = /auth|authentication|all configured authentication methods/i.test(message)
        ? 'AUTH_FAILED'
        : (error?.code === 'ETIMEDOUT' ? 'CONNECT_TIMEOUT' : 'SSH_CONNECT_FAILED');
      finishReject(rpcError(code, code === 'AUTH_FAILED' ? 'SSH authentication failed' : message));
    });
    client.once('close', () => {
      if (!settled) finishReject(rpcError('SSH_CONNECT_FAILED', 'SSH connection closed before ready'));
      connections.delete(connectionId);
    });

    try {
      const { config: clientConfig, timeoutMs } = makeClientConfig(payload, hostVerifier);
      connectTimer = setTimeout(() => {
        finishReject(rpcError('CONNECT_TIMEOUT', 'SSH connection timed out'));
        closeProbe();
      }, timeoutMs + 1000);
      client.connect(clientConfig);
    } catch (error) {
      finishReject(error);
      closeProbe();
    }
  });
}

function execOnSession(payload) {
  const connectionId = assertId(payload.connectionId, 'connectionId');
  const session = connections.get(connectionId);
  if (!session) throw rpcError('NOT_CONNECTED', 'SSH connection is not available');
  if (typeof payload.command !== 'string' || payload.command.length < 1 || payload.command.length > 32 * 1024 || /[\u0000]/.test(payload.command)) {
    throw rpcError('INVALID_INPUT', 'Invalid remote command');
  }
  const timeoutMs = assertTimeout(payload.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timer = null;
    let settled = false;
    const append = (current, chunk, limit) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > limit) throw rpcError('OUTPUT_LIMIT', 'Remote command output exceeded the limit');
      return next;
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    // Start the deadline before requesting the channel. Some half-open SSH
    // sessions never invoke the exec callback, so a callback-only timer can
    // leave the RPC hanging until Hana's much longer runtime timeout.
    timer = setTimeout(() => {
      finishReject(rpcError('SAMPLE_TIMEOUT', 'Remote command timed out'));
      try { session.client.end(); } catch {}
    }, timeoutMs);

    try {
      session.client.exec(payload.command, { pty: false }, (error, stream) => {
        if (settled) {
          try { stream?.close(); } catch {}
          return;
        }
        if (error) return finishReject(rpcError('SSH_EXEC_FAILED', 'SSH exec failed'));
        stream.on('data', (chunk) => {
          try { stdout = append(stdout, chunk, MAX_STDOUT_BYTES); }
          catch (err) { finishReject(err); try { stream.close(); } catch {} }
        });
        stream.stderr.on('data', (chunk) => {
          try { stderr = append(stderr, chunk, MAX_STDERR_BYTES); }
          catch (err) { finishReject(err); try { stream.close(); } catch {} }
        });
        stream.once('error', (err) => finishReject(rpcError('SSH_EXEC_FAILED', err?.message || 'SSH exec failed')));
        stream.once('close', (code, signal) => {
          if (settled) return;
          finishResolve({
            stdout: stdout.toString('utf8'),
            stderr: stderr.toString('utf8'),
            exitCode: Number.isInteger(code) ? code : 255,
            durationMs: 0,
            signal: signal ?? null,
          });
        });
      });
    } catch (error) {
      finishReject(rpcError('SSH_EXEC_FAILED', error?.message || 'SSH exec failed'));
    }
  });
}

async function disconnectSession(payload) {
  const connectionId = assertId(payload.connectionId, 'connectionId');
  const session = connections.get(connectionId);
  if (!session) return { disconnected: true };
  connections.delete(connectionId);
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    session.client.once('close', finish);
    try { session.client.end(); } catch { finish(); }
    setTimeout(finish, 1000);
  });
  return { disconnected: true };
}

async function dispatch(method, payload = {}) {
  if (method === 'status') return { ready: true };
  if (method === 'connect') return connectSession(payload);
  if (method === 'exec') return execOnSession(payload);
  if (method === 'disconnect') return disconnectSession(payload);
  if (method === 'close') {
    await Promise.all([...connections.keys()].map((connectionId) => disconnectSession({ connectionId })));
    return { closed: true };
  }
  throw rpcError('INVALID_INPUT', 'Unknown runtime method');
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw rpcError('OUTPUT_LIMIT', 'RPC request is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/rpc') {
      response.writeHead(404).end();
      return;
    }
    if (!safeBearerEqual(request.headers.authorization)) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }));
      return;
    }
    const parsed = JSON.parse(await readBody(request));
    const value = await dispatch(parsed?.method, parsed?.payload || {});
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, value }));
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'RUNTIME_ERROR';
    const message = typeof error?.message === 'string' ? error.message : 'Runtime request failed';
    response.writeHead(code === 'UNAUTHORIZED' ? 401 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: { code, message } }));
  }
});

server.requestTimeout = 35_000;
server.headersTimeout = 10_000;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, '127.0.0.1', resolve);
});
console.log('VPS_SSH_READY');

async function stop() {
  if (stopping) return;
  stopping = true;
  await dispatch('close').catch(() => {});
  await new Promise((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
}
process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });

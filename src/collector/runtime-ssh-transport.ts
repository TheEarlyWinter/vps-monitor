import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  ErrorCodes,
  VpsMonitorError,
  type HostKeyPin
} from '../types/index.ts';
import type {
  ExecResult,
  SshConnectOptions,
  SshConnectResult,
  SshTransport
} from './ssh-transport.ts';

interface ManagedRuntime {
  start(input: Record<string, unknown>): Promise<{ runtimeId?: string }>;
  get(runtimeId: string): Promise<{ state?: string; service?: { state?: string }} | null>;
  fetch(runtimeId: string, requestPath: string, init?: Record<string, unknown>): Promise<Response>;
  stop(runtimeId: string): Promise<unknown>;
}

const START_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;
const RPC_TIMEOUT_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function mapRuntimeError(error: any): VpsMonitorError {
  if (error instanceof VpsMonitorError) return error;
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : 'SSH runtime request failed';
  switch (code) {
    case 'AUTH_FAILED':
      return new VpsMonitorError(ErrorCodes.AUTH_FAILED, 'SSH authentication failed');
    case 'CONNECT_TIMEOUT':
      return new VpsMonitorError(ErrorCodes.CONNECT_TIMEOUT, 'SSH connection timed out');
    case 'SAMPLE_TIMEOUT':
      return new VpsMonitorError(ErrorCodes.SAMPLE_TIMEOUT, 'Remote command timed out');
    case 'OUTPUT_LIMIT':
      return new VpsMonitorError(ErrorCodes.OUTPUT_LIMIT, 'Remote command output exceeded the limit');
    case 'HOST_KEY_CHANGED':
      return new VpsMonitorError(ErrorCodes.HOST_KEY_CHANGED, 'SSH host key verification failed');
    case 'RUNTIME_START_FAILED':
    case 'RUNTIME_START_TIMEOUT':
    case 'PERMISSION_REQUIRED':
    case 'RUNTIME_PERMISSION_DENIED':
      return new VpsMonitorError(ErrorCodes.PERMISSION_REQUIRED, 'Hana external network runtime is unavailable');
    case 'UNSUPPORTED_AUTH':
      return new VpsMonitorError(ErrorCodes.UNSUPPORTED_AUTH, 'Unsupported SSH authentication method');
    case 'INVALID_INPUT':
      return new VpsMonitorError(ErrorCodes.INVALID_INPUT, message);
    default:
      return new VpsMonitorError(ErrorCodes.SAMPLE_TIMEOUT, message);
  }
}

function assertConnectionId(value: string): string {
  if (!SAFE_ID.test(value)) throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid SSH connection id');
  return value;
}

export class HanaSshTransport implements SshTransport {
  private runtimeId: string | null = null;
  private readonly rpcSecret = randomBytes(32).toString('hex');
  private readonly connectionId = assertConnectionId(`ssh-${randomUUID()}`);
  private configFile: string | null = null;
  private connected = false;
  private readonly runtime: ManagedRuntime;
  private readonly dataDir: string;

  public constructor(runtime: ManagedRuntime, dataDir: string) {
    this.runtime = runtime;
    this.dataDir = dataDir;
  }

  public async connect(options: SshConnectOptions): Promise<SshConnectResult> {
    await this.ensureRuntime();
    try {
      const result = await this.rpc('connect', {
        connectionId: this.connectionId,
        host: options.host,
        port: options.port,
        username: options.username,
        auth: options.auth,
        expectedHostKeyPin: options.expectedHostKeyPin,
        verifyHostKeyOnly: options.verifyHostKeyOnly === true,
        timeoutMs: options.timeoutMs
      }) as SshConnectResult;
      this.connected = result.pinMatched === true;
      return result;
    } catch (error) {
      this.connected = false;
      await this.disconnect();
      throw mapRuntimeError(error);
    }
  }

  public async exec(command: string, timeoutMs: number): Promise<ExecResult> {
    if (!this.connected || !this.runtimeId) {
      throw new VpsMonitorError(ErrorCodes.SAMPLE_TIMEOUT, 'SSH connection is not available');
    }
    const startedAt = Date.now();
    try {
      const result = await this.rpc('exec', {
        connectionId: this.connectionId,
        command,
        timeoutMs
      }) as ExecResult;
      return { ...result, durationMs: Date.now() - startedAt };
    } catch (error) {
      throw mapRuntimeError(error);
    }
  }

  public async disconnect(): Promise<void> {
    const runtimeId = this.runtimeId;
    this.connected = false;
    this.runtimeId = null;
    try {
      if (runtimeId) {
        await this.rpcWithRuntime(runtimeId, 'disconnect', { connectionId: this.connectionId });
      }
    } catch {
      // Cleanup must continue even if the sidecar is already gone.
    } finally {
      if (runtimeId) await this.runtime.stop(runtimeId).catch(() => undefined);
      this.removeConfigFile();
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  private async ensureRuntime(): Promise<void> {
    if (this.runtimeId) return;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const port = randomInt(40_000, 60_000);
    this.configFile = path.join(this.dataDir, `.vps-ssh-runtime-${randomUUID()}.json`);
    fs.writeFileSync(
      this.configFile,
      JSON.stringify({ port, secret: this.rpcSecret }),
      { encoding: 'utf8', mode: 0o600 }
    );

    try {
      const started = await this.runtime.start({
        runtime: 'node',
        profile: 'scoped',
        network: 'external',
        entry: 'runtime/ssh-service.mjs',
        args: [this.configFile],
        // Each transport owns an independent managed service. A fixed service
        // id makes the second VPS collide while the first runtime is stopping.
        service: { port, readyMarker: 'VPS_SSH_READY', id: this.connectionId }
      });
      if (!started?.runtimeId) throw Object.assign(new Error('Hana did not return a runtime id'), { code: 'RUNTIME_START_FAILED' });
      this.runtimeId = started.runtimeId;
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() <= deadline) {
        const info = await this.runtime.get(this.runtimeId);
        if (!info || ['failed', 'exited', 'stopped'].includes(info.state ?? '')) {
          throw Object.assign(new Error('SSH runtime failed to start'), { code: 'RUNTIME_START_FAILED' });
        }
        if (info.state === 'ready' && info.service?.state === 'ready') {
          const status = await this.rpc('status', {});
          if ((status as { ready?: boolean })?.ready === true) {
            this.removeConfigFile();
            return;
          }
        }
        await new Promise(resolve => setTimeout(resolve, READY_POLL_MS));
      }
      throw Object.assign(new Error('SSH runtime start timed out'), { code: 'RUNTIME_START_TIMEOUT' });
    } catch (error) {
      const runtimeId = this.runtimeId;
      this.runtimeId = null;
      if (runtimeId) await this.runtime.stop(runtimeId).catch(() => undefined);
      this.removeConfigFile();
      throw mapRuntimeError(error);
    }
  }

  private async rpc(method: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.runtimeId) throw new VpsMonitorError(ErrorCodes.PERMISSION_REQUIRED, 'SSH runtime is not running');
    return this.rpcWithRuntime(this.runtimeId, method, payload);
  }

  private async rpcWithRuntime(runtimeId: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.runtime.fetch(runtimeId, '/rpc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.rpcSecret}`
        },
        body: JSON.stringify({ method, payload }),
        timeoutMs: RPC_TIMEOUT_MS
      });
    } catch (error) {
      throw mapRuntimeError(error);
    }

    let body: any = null;
    try { body = await response.json(); } catch {
      throw new VpsMonitorError(ErrorCodes.SAMPLE_TIMEOUT, 'SSH runtime returned invalid response');
    }
    if (!response.ok || body?.ok !== true) {
      throw Object.assign(
        new Error(body?.error?.message || 'SSH runtime request failed'),
        { code: body?.error?.code || 'RUNTIME_ERROR' }
      );
    }
    return body.value;
  }

  private removeConfigFile(): void {
    if (!this.configFile) return;
    try { fs.rmSync(this.configFile, { force: true }); } catch {}
    this.configFile = null;
  }
}

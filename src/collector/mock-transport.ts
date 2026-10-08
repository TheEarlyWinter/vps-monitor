/**
 * 受控测试用 Mock SSH Transport
 * 供 M0 纯函数与受控状态机单元测试使用
 */

import {
  ErrorCodes,
  VpsMonitorError,
  type HostKeyPin
} from '../types/index.ts';
import type {
  SshTransport,
  SshConnectOptions,
  SshConnectResult,
  ExecResult
} from './ssh-transport.ts';

export interface MockTransportBehaviors {
  mockHostKey?: HostKeyPin;
  connectError?: Error;
  authError?: boolean;
  execOutput?: string | (() => string);
  execDelayMs?: number;
  execError?: Error;
}

export class MockSshTransport implements SshTransport {
  private connected = false;
  public behaviors: MockTransportBehaviors = {};

  constructor(behaviors: MockTransportBehaviors = {}) {
    this.behaviors = behaviors;
  }

  public async connect(options: SshConnectOptions): Promise<SshConnectResult> {
    if (this.behaviors.connectError) {
      throw this.behaviors.connectError;
    }

    const hostKey = this.behaviors.mockHostKey ?? {
      algorithm: 'ssh-ed25519',
      publicKeyBlob: 'QUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU9K...',
      fingerprintSha256: 'SHA256:4b9a39f426fdf1e7db9a39f426fdf1e7d',
      confirmedAt: new Date().toISOString()
    };

    if (options.verifyHostKeyOnly || options.expectedHostKeyPin === null) {
      // Host-key inspection must never authenticate or leave a live session.
      return { actualHostKey: hostKey, pinMatched: false };
    }

    if (options.expectedHostKeyPin.fingerprintSha256 !== hostKey.fingerprintSha256) {
      throw new VpsMonitorError(
        ErrorCodes.HOST_KEY_CHANGED,
        `Host key changed for ${options.host}:${options.port}`
      );
    }

    if (this.behaviors.authError) {
      throw new VpsMonitorError(
        ErrorCodes.AUTH_FAILED,
        `Authentication failed for user ${options.username}`
      );
    }

    this.connected = true;
    return { actualHostKey: hostKey, pinMatched: true };
  }

  public async exec(command: string, timeoutMs: number): Promise<ExecResult> {
    if (!this.connected) {
      throw new VpsMonitorError(ErrorCodes.CONNECT_TIMEOUT, 'SSH session not connected');
    }

    if (this.behaviors.execError) {
      throw this.behaviors.execError;
    }

    const delay = this.behaviors.execDelayMs ?? 10;
    if (delay > timeoutMs) {
      throw new VpsMonitorError(
        ErrorCodes.SAMPLE_TIMEOUT,
        `Command execution timed out after ${timeoutMs}ms`
      );
    }

    const output = typeof this.behaviors.execOutput === 'function'
      ? this.behaviors.execOutput()
      : (this.behaviors.execOutput ?? '');

    return {
      stdout: output,
      stderr: '',
      exitCode: 0,
      durationMs: delay
    };
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
  }

  public isConnected(): boolean {
    return this.connected;
  }
}

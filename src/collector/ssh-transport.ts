/**
 * SSH 传输抽象与执行接口
 * 遵循技术实施规范第 3.1、4.2 节
 */

import {
  ErrorCodes,
  VpsMonitorError,
  type HostKeyPin
} from '../types/index.ts';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface SshConnectOptions {
  host: string;
  port: number;
  username: string;
  auth?: {
    kind: 'password' | 'privateKey';
    secret: string;
    passphrase?: string;
  };
  expectedHostKeyPin: HostKeyPin | null;
  /**
   * Host-key inspection must not authenticate. A real transport must honor
   * this flag by using a pre-auth verifier or an equivalent handshake.
   */
  verifyHostKeyOnly?: boolean;
  timeoutMs?: number;
}

export interface SshConnectResult {
  actualHostKey: HostKeyPin;
  pinMatched: boolean;
}

export interface SshTransport {
  connect(options: SshConnectOptions): Promise<SshConnectResult>;
  exec(command: string, timeoutMs: number): Promise<ExecResult>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

/**
 * Safe production default while Hana's approved TCP runtime is unavailable.
 * Never return fixture data or pretend that a VPS is online.
 */
export class UnavailableSshTransport implements SshTransport {
  public async connect(_options: SshConnectOptions): Promise<SshConnectResult> {
    throw new VpsMonitorError(
      ErrorCodes.PERMISSION_REQUIRED,
      'SSH transport is unavailable until the approved Hana network runtime is configured'
    );
  }

  public async exec(_command: string, _timeoutMs: number): Promise<ExecResult> {
    throw new VpsMonitorError(
      ErrorCodes.PERMISSION_REQUIRED,
      'SSH transport is unavailable'
    );
  }

  public async disconnect(): Promise<void> {
    // Nothing to release: this transport never opens a socket.
  }

  public isConnected(): boolean {
    return false;
  }
}

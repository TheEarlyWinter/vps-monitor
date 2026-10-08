/**
 * vps-monitor 统一错误码与异常契约
 * 遵循技术实施规范第 9 节
 */

export const ErrorCodes = {
  INVALID_INPUT: 'INVALID_INPUT',
  CONFIG_CONFLICT: 'CONFIG_CONFLICT',
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  CREDENTIAL_LOCKED: 'CREDENTIAL_LOCKED',
  HOST_KEY_REQUIRED: 'HOST_KEY_REQUIRED',
  HOST_KEY_CHANGED: 'HOST_KEY_CHANGED',
  AUTH_FAILED: 'AUTH_FAILED',
  CONNECT_TIMEOUT: 'CONNECT_TIMEOUT',
  PROXY_FAILED: 'PROXY_FAILED',
  SAMPLE_TIMEOUT: 'SAMPLE_TIMEOUT',
  OUTPUT_LIMIT: 'OUTPUT_LIMIT',
  PARSE_ERROR: 'PARSE_ERROR',
  STORAGE_ERROR: 'STORAGE_ERROR',
  UNSUPPORTED_AUTH: 'UNSUPPORTED_AUTH'
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface AppErrorDetail {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class VpsMonitorError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'VpsMonitorError';
    this.code = code;
    this.details = details;
  }

  toDTO(): AppErrorDetail {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {})
    };
  }
}

/**
 * vps-monitor 服务器与凭据配置契约
 * 遵循技术实施规范第 2.3 节
 */

export interface HostKeyPin {
  algorithm: string;
  publicKeyBlob: string; // base64
  fingerprintSha256: string; // e.g. "SHA256:xxxx"
  confirmedAt: string; // ISO 8601 UTC
}

export type AuthKind = 'password' | 'privateKey';
export type NetworkSelection = 'auto' | 'explicit';
export type QuotaDirection = 'rx' | 'tx' | 'sum';

export interface ServerConfig {
  id: string; // UUID
  revision: number; // 单调递增
  name: string;
  host: string; // DNS, IPv4, 裸 IPv6
  port: number; // 默认 22
  username: string;
  authKind: AuthKind;
  credentialRef: string; // 凭据库引用 UUID，绝不回传 UI
  hostKey: HostKeyPin | null; // 首次确认后 pin
  proxyRef: string | null;
  networkSelection: NetworkSelection;
  interfaceNames: string[]; // explicit 时生效，仅用于本地过滤，不传入远端 shell
  quotaBytes: string | null; // 大整数字符串，null 表示未设配额
  quotaDirection: QuotaDirection;
  resetDay: number; // 1..31
  billingTimeZone: string; // IANA 时区，如 "America/Los_Angeles"
  enabled: boolean;
  sampleIntervalMs: number; // 默认 5000 (前台) / 30000 (后台)
}

/**
 * 前端可安全消费的 Server DTO，绝对不包含 credentialRef 或任何密码私钥
 */
export interface PublicServerDTO {
  id: string;
  revision: number;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: AuthKind;
  hasCredential: boolean;
  hostKeyConfirmed: boolean;
  hostKeyFingerprint: string | null;
  proxyRef: string | null;
  networkSelection: NetworkSelection;
  interfaceNames: string[];
  quotaBytes: string | null;
  quotaDirection: QuotaDirection;
  resetDay: number;
  billingTimeZone: string;
  enabled: boolean;
  sampleIntervalMs: number;
}

export function toPublicServerDTO(config: ServerConfig, hasCredential = true): PublicServerDTO {
  return {
    id: config.id,
    revision: config.revision,
    name: config.name,
    host: config.host,
    port: config.port,
    username: config.username,
    authKind: config.authKind,
    hasCredential,
    hostKeyConfirmed: config.hostKey !== null,
    hostKeyFingerprint: config.hostKey?.fingerprintSha256 ?? null,
    proxyRef: config.proxyRef,
    networkSelection: config.networkSelection,
    interfaceNames: [...config.interfaceNames],
    quotaBytes: config.quotaBytes,
    quotaDirection: config.quotaDirection,
    resetDay: config.resetDay,
    billingTimeZone: config.billingTimeZone,
    enabled: config.enabled,
    sampleIntervalMs: config.sampleIntervalMs
  };
}

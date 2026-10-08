/**
 * vps-monitor 状态与指标质量契约
 * 遵循技术实施规范第 6.4、8.1 节
 */

export type ConnectionState =
  | 'disabled'
  | 'credential_locked'
  | 'permission_required'
  | 'connecting'
  | 'host_key_required'
  | 'host_key_changed'
  | 'auth_failed'
  | 'online'
  | 'retry_wait'
  | 'unreachable'
  | 'stopping';

export type CollectionHealth =
  | 'warming_up'
  | 'collecting'
  | 'degraded'
  | 'stale';

export type MetricQuality =
  | 'valid'
  | 'warming_up'
  | 'estimated'
  | 'interval_average'
  | 'unavailable'
  | 'invalid'
  | 'stale';

export interface MetricValue<T = number | string | null> {
  value: T;
  unit: string;
  quality: MetricQuality;
  reason?: string;
  sampledAt: string; // ISO 8601 UTC
}

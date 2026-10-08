/**
 * 仪表盘与订阅消费的快照数据契约 (SnapshotDTO)
 * 遵循技术实施规范第 9 节
 */

import type { ConnectionState, CollectionHealth, MetricValue } from './metrics.ts';
import type { TrafficPeriodDTO } from './traffic.ts';

export interface CpuSnapshot {
  busyPercent: MetricValue<number | null>;
  stealPercent: MetricValue<number | null>;
  iowaitPercent: MetricValue<number | null>;
  cores: number;
}

export interface LoadSnapshot {
  load1: MetricValue<number | null>;
  load5: MetricValue<number | null>;
  load15: MetricValue<number | null>;
}

export interface MemorySnapshot {
  totalBytes: MetricValue<string | null>;
  usedBytes: MetricValue<string | null>;
  usedPercent: MetricValue<number | null>;
  isEstimated: boolean;
}

export interface SwapSnapshot {
  totalBytes: MetricValue<string | null>;
  usedBytes: MetricValue<string | null>;
  usedPercent: MetricValue<number | null>; // SwapTotal=0 时为 null
  isConfigured: boolean;
}

export interface FilesystemSnapshot {
  mountpoint: string;
  totalBytes: string;
  usedBytes: string;
  availableBytes: string;
  usedPercent: number;
  isRoot: boolean;
}

export interface NetworkSnapshot {
  rxBps: MetricValue<string | null>;
  txBps: MetricValue<string | null>;
  activeInterfaces: string[];
}

export interface SnapshotDTO {
  serverId: string;
  seq: number;
  connectionState: ConnectionState;
  collectionHealth: CollectionHealth;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  sshRequestLatencyMs: number | null;
  uptimeSec: MetricValue<number | null>;
  cpu: CpuSnapshot;
  load: LoadSnapshot;
  memory: MemorySnapshot;
  swap: SwapSnapshot;
  filesystems: FilesystemSnapshot[];
  network: NetworkSnapshot;
  trafficPeriod: TrafficPeriodDTO | null;
  warnings: string[];
}

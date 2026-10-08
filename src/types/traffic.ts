/**
 * 月度流量与账本数据契约
 * 遵循技术实施规范第 7 节
 */

import type { QuotaDirection } from './config.ts';

export interface GapInterval {
  from: string; // ISO 8601 UTC
  to: string;   // ISO 8601 UTC
  reason: 'reboot' | 'ifindex_change' | 'counter_drop' | 'discontinuity' | 'time_anomaly';
}

export type CoverageStatus =
  | 'observed_only'
  | 'continuous_since_enabled'
  | 'incomplete';

export interface TrafficPeriodDTO {
  periodStart: string; // ISO 8601 UTC
  periodEnd: string;   // ISO 8601 UTC
  billingTimeZone: string;
  quotaBytes: string | null;
  quotaDirection: QuotaDirection;
  observedRxBytes: string;
  observedTxBytes: string;
  observedTotalBytes: string;
  manualOpeningBytes: string;
  unallocatedBytes: string;
  gapIntervals: GapInterval[];
  coverageStatus: CoverageStatus;
  observationStartedAt: string;
  accountingEpoch: string;
}

export interface InterfaceCounterCheckpoint {
  name: string;
  ifindex: number | null;
  rxBytes: string; // 十进制 bigint
  txBytes: string; // 十进制 bigint
  recordedAt: string;
  uptimeSec: number;
}

export interface TrafficCheckpoint {
  serverId: string;
  accountingEpoch: string;
  generation: number;
  sampleSeq: number;
  bootId: string | null;
  uptimeSec: number;
  timestampUtc: string;
  interfaces: Record<string, InterfaceCounterCheckpoint>;
}

export interface AccountingTransaction {
  txnId: string; // 唯一增量 ID: serverId + accountingEpoch + runId + generation + sampleSeq + interface
  serverId: string;
  accountingEpoch: string;
  generation: number;
  sampleSeq: number;
  periodStart: string;
  periodEnd: string;
  interfaceName: string;
  deltaRxBytes: string;
  deltaTxBytes: string;
  unallocatedBytes: string;
  isGap: boolean;
  gapReason?: GapInterval['reason'];
  recordedAt: string;
}

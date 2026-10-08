/**
 * Linux /proc 原始解析数据结构契约
 * 遵循技术实施规范第 5.3 节
 */

export interface CpuTicks {
  user: bigint;
  nice: bigint;
  system: bigint;
  idle: bigint;
  iowait: bigint;
  irq: bigint;
  softirq: bigint;
  steal: bigint;
  guest: bigint;
  guestNice: bigint;
  total: bigint; // user+nice+system+idle+iowait+irq+softirq+steal (guest/guestNice 已包含在 user/nice)
  busy: bigint;  // total - idle - iowait
}

export interface LoadAvg {
  load1: number;
  load5: number;
  load15: number;
  runningThreads: number;
  totalThreads: number;
  lastPid: number;
  cpuCores: number;
}

export interface MemoryInfo {
  memTotal: bigint;
  memAvailable: bigint | null;
  memFree: bigint;
  buffers: bigint;
  cached: bigint;
  sReclaimable: bigint;
  shmem: bigint;
  swapTotal: bigint;
  swapFree: bigint;
}

export interface InterfaceInfo {
  name: string;
  ifindex: number | null;
  rxBytes: bigint;
  txBytes: bigint;
  rxPackets: bigint;
  txPackets: bigint;
  rxErrors: bigint;
  txErrors: bigint;
  rxDrops: bigint;
  txDrops: bigint;
}

export interface FilesystemInfo {
  filesystem: string;
  totalBytes: bigint;
  usedBytes: bigint;
  availableBytes: bigint;
  capacityPercent: number;
  mountpoint: string;
}

export interface SampleCapabilities {
  hasStat: boolean;
  hasMeminfo: boolean;
  hasNetdev: boolean;
  hasDf: boolean;
  hasBootId: boolean;
  hasIfindex: boolean;
}

export interface RawSample {
  protocolVersion: 'VMON/1';
  serverId: string;
  generation: number;
  sampleSeq: number;
  receivedAtUtc: string; // ISO 8601 UTC
  localMonotonicNs: bigint;
  uptimeBeginSec: number;
  uptimeEndSec: number;
  bootId: string | null;
  cpuTicks: CpuTicks | null;
  loadAvg: LoadAvg | null;
  memoryInfo: MemoryInfo | null;
  interfaces: InterfaceInfo[];
  filesystems: FilesystemInfo[];
  capabilities: SampleCapabilities;
  warnings: string[];
}

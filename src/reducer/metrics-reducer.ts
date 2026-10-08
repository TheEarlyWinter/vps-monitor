/**
 * 指标差分器 (MetricsReducer)
 * 纯函数实现 CPU、内存、SWAP、磁盘与实时网络速率计算
 * 遵循技术实施规范第 6 节
 */

import type {
  ServerConfig,
  RawSample,
  SnapshotDTO,
  CollectionHealth,
  CpuSnapshot,
  LoadSnapshot,
  MemorySnapshot,
  SwapSnapshot,
  FilesystemSnapshot,
  NetworkSnapshot,
  MetricValue
} from '../types/index.ts';

const VIRTUAL_IFACE_REGEX = /^(lo|docker.*|veth.*|br-.*|virbr.*|tun.*|tap.*|wg.*)$/;

export function reduceSnapshot(
  current: RawSample,
  previous: RawSample | null,
  config: ServerConfig,
  baseSnapshot?: Partial<SnapshotDTO>
): SnapshotDTO {
  const sampledAt = current.receivedAtUtc;
  const warnings = [...current.warnings];

  // 1. Uptime
  const uptimeSec: MetricValue<number | null> = {
    value: current.uptimeBeginSec,
    unit: 's',
    quality: 'valid',
    sampledAt
  };

  // 2. CPU
  const cpu = reduceCpu(current, previous, sampledAt, warnings);

  // 3. Load
  const load = reduceLoad(current, sampledAt);

  // 4. Memory
  const memory = reduceMemory(current, sampledAt, warnings);

  // 5. Swap
  const swap = reduceSwap(current, sampledAt);

  // 6. Filesystems
  const filesystems = reduceFilesystems(current);

  // 7. Network Rate
  const network = reduceNetwork(current, previous, config, sampledAt, warnings);

  // 判断整体采集健康度
  let collectionHealth: CollectionHealth = 'collecting';
  if (!previous || cpu.busyPercent.quality === 'warming_up') {
    collectionHealth = 'warming_up';
  } else if (
    warnings.length > 0 ||
    cpu.busyPercent.quality === 'estimated' ||
    memory.isEstimated
  ) {
    collectionHealth = 'degraded';
  }

  return {
    serverId: current.serverId,
    seq: current.sampleSeq,
    connectionState: baseSnapshot?.connectionState ?? 'online',
    collectionHealth,
    lastSuccessAt: sampledAt,
    lastAttemptAt: baseSnapshot?.lastAttemptAt ?? sampledAt,
    nextRetryAt: null,
    sshRequestLatencyMs: baseSnapshot?.sshRequestLatencyMs ?? null,
    uptimeSec,
    cpu,
    load,
    memory,
    swap,
    filesystems,
    network,
    trafficPeriod: baseSnapshot?.trafficPeriod ?? null,
    warnings
  };
}

function reduceCpu(
  current: RawSample,
  previous: RawSample | null,
  sampledAt: string,
  warnings: string[]
): CpuSnapshot {
  const cores = current.cpuTicks ? (current.loadAvg?.cpuCores ?? 1) : 1;

  if (
    !previous ||
    !previous.cpuTicks ||
    !current.cpuTicks ||
    current.generation !== previous.generation ||
    current.bootId !== previous.bootId
  ) {
    return {
      busyPercent: { value: null, unit: '%', quality: 'warming_up', sampledAt },
      stealPercent: { value: null, unit: '%', quality: 'warming_up', sampledAt },
      iowaitPercent: { value: null, unit: '%', quality: 'warming_up', sampledAt },
      cores
    };
  }

  const curr = current.cpuTicks;
  const prev = previous.cpuTicks;

  const deltaTotal = curr.total - prev.total;
  const deltaBusy = curr.busy - prev.busy;
  const deltaSteal = curr.steal - prev.steal;
  const deltaIowait = curr.iowait - prev.iowait;

  if (deltaTotal <= 0n || deltaBusy < 0n || deltaSteal < 0n) {
    warnings.push('cpu_counter_discontinuity');
    return {
      busyPercent: { value: null, unit: '%', quality: 'invalid', reason: 'Zero or negative CPU total delta', sampledAt },
      stealPercent: { value: null, unit: '%', quality: 'invalid', sampledAt },
      iowaitPercent: { value: null, unit: '%', quality: 'invalid', sampledAt },
      cores
    };
  }

  let cpuQuality: CpuSnapshot['busyPercent']['quality'] = 'valid';

  // 检测 iowait 倒退 (Linux 内核某些多核场景下的已知偶发情况)
  if (deltaIowait < 0n) {
    warnings.push('cpu_iowait_backwards');
    cpuQuality = 'estimated';
  }

  const busyPercentVal = Math.min(100, Math.max(0, Number(deltaBusy * 10000n / deltaTotal) / 100));
  const stealPercentVal = Math.min(100, Math.max(0, Number(deltaSteal * 10000n / deltaTotal) / 100));
  const iowaitPercentVal = deltaIowait >= 0n
    ? Math.min(100, Math.max(0, Number(deltaIowait * 10000n / deltaTotal) / 100))
    : 0;

  return {
    busyPercent: { value: busyPercentVal, unit: '%', quality: cpuQuality, sampledAt },
    stealPercent: { value: stealPercentVal, unit: '%', quality: 'valid', sampledAt },
    iowaitPercent: { value: iowaitPercentVal, unit: '%', quality: deltaIowait < 0n ? 'estimated' : 'valid', sampledAt },
    cores
  };
}

function reduceLoad(current: RawSample, sampledAt: string): LoadSnapshot {
  if (!current.loadAvg) {
    return {
      load1: { value: null, unit: '', quality: 'unavailable', sampledAt },
      load5: { value: null, unit: '', quality: 'unavailable', sampledAt },
      load15: { value: null, unit: '', quality: 'unavailable', sampledAt }
    };
  }

  return {
    load1: { value: current.loadAvg.load1, unit: '', quality: 'valid', sampledAt },
    load5: { value: current.loadAvg.load5, unit: '', quality: 'valid', sampledAt },
    load15: { value: current.loadAvg.load15, unit: '', quality: 'valid', sampledAt }
  };
}

function reduceMemory(current: RawSample, sampledAt: string, warnings: string[]): MemorySnapshot {
  const mem = current.memoryInfo;
  if (!mem) {
    return {
      totalBytes: { value: null, unit: 'bytes', quality: 'unavailable', sampledAt },
      usedBytes: { value: null, unit: 'bytes', quality: 'unavailable', sampledAt },
      usedPercent: { value: null, unit: '%', quality: 'unavailable', sampledAt },
      isEstimated: false
    };
  }

  let usedBytes: bigint;
  let isEstimated = false;

  if (mem.memAvailable !== null) {
    usedBytes = mem.memTotal >= mem.memAvailable ? mem.memTotal - mem.memAvailable : 0n;
  } else {
    // MemAvailable 缺失时的备用估算法: MemFree + Buffers + Cached + SReclaimable - Shmem
    const estFree = mem.memFree + mem.buffers + mem.cached + mem.sReclaimable - mem.shmem;
    usedBytes = mem.memTotal >= estFree ? mem.memTotal - estFree : 0n;
    isEstimated = true;
    warnings.push('mem_available_estimated');
  }

  const usedPercent = mem.memTotal > 0n
    ? Math.min(100, Math.max(0, Number(usedBytes * 10000n / mem.memTotal) / 100))
    : 0;

  return {
    totalBytes: { value: mem.memTotal.toString(), unit: 'bytes', quality: 'valid', sampledAt },
    usedBytes: { value: usedBytes.toString(), unit: 'bytes', quality: isEstimated ? 'estimated' : 'valid', sampledAt },
    usedPercent: { value: usedPercent, unit: '%', quality: isEstimated ? 'estimated' : 'valid', sampledAt },
    isEstimated
  };
}

function reduceSwap(current: RawSample, sampledAt: string): SwapSnapshot {
  const mem = current.memoryInfo;
  if (!mem) {
    return {
      totalBytes: { value: null, unit: 'bytes', quality: 'unavailable', sampledAt },
      usedBytes: { value: null, unit: 'bytes', quality: 'unavailable', sampledAt },
      usedPercent: { value: null, unit: '%', quality: 'unavailable', sampledAt },
      isConfigured: false
    };
  }

  if (mem.swapTotal === 0n) {
    return {
      totalBytes: { value: '0', unit: 'bytes', quality: 'valid', sampledAt },
      usedBytes: { value: '0', unit: 'bytes', quality: 'valid', sampledAt },
      usedPercent: { value: null, unit: '%', quality: 'valid', sampledAt },
      isConfigured: false
    };
  }

  const swapUsed = mem.swapTotal >= mem.swapFree ? mem.swapTotal - mem.swapFree : 0n;
  const swapPercent = Math.min(100, Math.max(0, Number(swapUsed * 10000n / mem.swapTotal) / 100));

  return {
    totalBytes: { value: mem.swapTotal.toString(), unit: 'bytes', quality: 'valid', sampledAt },
    usedBytes: { value: swapUsed.toString(), unit: 'bytes', quality: 'valid', sampledAt },
    usedPercent: { value: swapPercent, unit: '%', quality: 'valid', sampledAt },
    isConfigured: true
  };
}

function reduceFilesystems(current: RawSample): FilesystemSnapshot[] {
  return current.filesystems.map(fs => ({
    mountpoint: fs.mountpoint,
    totalBytes: fs.totalBytes.toString(),
    usedBytes: fs.usedBytes.toString(),
    availableBytes: fs.availableBytes.toString(),
    usedPercent: fs.capacityPercent,
    isRoot: fs.mountpoint === '/'
  }));
}

function reduceNetwork(
  current: RawSample,
  previous: RawSample | null,
  config: ServerConfig,
  sampledAt: string,
  warnings: string[]
): NetworkSnapshot {
  // 确定有效接口
  const selectedInterfaces = filterInterfaces(current.interfaces.map(i => i.name), config);

  if (
    !previous ||
    current.generation !== previous.generation ||
    current.bootId !== previous.bootId
  ) {
    return {
      rxBps: { value: null, unit: 'B/s', quality: 'warming_up', sampledAt },
      txBps: { value: null, unit: 'B/s', quality: 'warming_up', sampledAt },
      activeInterfaces: selectedInterfaces
    };
  }

  const deltaUptime = current.uptimeBeginSec - previous.uptimeBeginSec;
  if (deltaUptime <= 0) {
    warnings.push('network_uptime_delta_non_positive');
    return {
      rxBps: { value: null, unit: 'B/s', quality: 'invalid', reason: 'Non-positive uptime difference', sampledAt },
      txBps: { value: null, unit: 'B/s', quality: 'invalid', reason: 'Non-positive uptime difference', sampledAt },
      activeInterfaces: selectedInterfaces
    };
  }

  const prevMap = new Map(previous.interfaces.map(i => [i.name, i]));
  let totalDeltaRx = 0n;
  let totalDeltaTx = 0n;
  let countValid = 0;
  let discontinuity = false;

  for (const name of selectedInterfaces) {
    const currIface = current.interfaces.find(i => i.name === name);
    const prevIface = prevMap.get(name);

    if (!currIface || !prevIface) {
      warnings.push(`iface_missing:${name}`);
      discontinuity = true;
      continue;
    }
    if (
      currIface.ifindex !== null &&
      prevIface.ifindex !== null &&
      currIface.ifindex !== prevIface.ifindex
    ) {
      warnings.push(`iface_ifindex_change:${name}`);
      discontinuity = true;
      continue;
    }
    if (currIface.rxBytes >= prevIface.rxBytes && currIface.txBytes >= prevIface.txBytes) {
      totalDeltaRx += (currIface.rxBytes - prevIface.rxBytes);
      totalDeltaTx += (currIface.txBytes - prevIface.txBytes);
      countValid++;
    } else {
      warnings.push(`iface_counter_drop:${name}`);
      discontinuity = true;
    }
  }

  if (discontinuity || countValid === 0) {
    return {
      rxBps: { value: '0', unit: 'B/s', quality: 'warming_up', sampledAt },
      txBps: { value: '0', unit: 'B/s', quality: 'warming_up', sampledAt },
      activeInterfaces: selectedInterfaces
    };
  }

  // 毫秒级精度计算 (乘以 1000 处理浮点时间)
  const deltaMs = BigInt(Math.max(1, Math.round(deltaUptime * 1000)));
  const rxBps = (totalDeltaRx * 1000n) / deltaMs;
  const txBps = (totalDeltaTx * 1000n) / deltaMs;

  return {
    rxBps: { value: rxBps.toString(), unit: 'B/s', quality: 'valid', sampledAt },
    txBps: { value: txBps.toString(), unit: 'B/s', quality: 'valid', sampledAt },
    activeInterfaces: selectedInterfaces
  };
}

export function filterInterfaces(allNames: string[], config: ServerConfig): string[] {
  if (config.networkSelection === 'explicit' && config.interfaceNames.length > 0) {
    const set = new Set(config.interfaceNames);
    return allNames.filter(n => set.has(n));
  }

  // auto 模式: 过滤常见回环与虚拟网卡
  return allNames.filter(n => !VIRTUAL_IFACE_REGEX.test(n));
}

/**
 * Linux VMON/1 单行采集输出解析器
 * 遵循技术实施规范第 5 节与第 6 节
 */

import {
  ErrorCodes,
  VpsMonitorError,
  type RawSample,
  type CpuTicks,
  type LoadAvg,
  type MemoryInfo,
  type InterfaceInfo,
  type FilesystemInfo,
  type SampleCapabilities
} from '../types/index.ts';

export interface ParseOptions {
  serverId: string;
  generation: number;
  sampleSeq: number;
  receivedAtUtc?: string;
  localMonotonicNs?: bigint;
}

const SECTION_HEADER_REGEX = /^@@([a-zA-Z0-9_]+)$/;
const DF_ROW_REGEX = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/;

export function parseVmon1Output(rawText: string, options: ParseOptions): RawSample {
  if (!rawText || typeof rawText !== 'string') {
    throw new VpsMonitorError(ErrorCodes.PARSE_ERROR, 'Raw output is empty or invalid type');
  }

  // 1. 去除有害控制字符 (保留 \n, \t, \r)
  const cleaned = rawText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const lines = cleaned.split(/\r?\n/);
  
  // 校验首行协议标记
  let firstLineIdx = 0;
  while (firstLineIdx < lines.length && lines[firstLineIdx].trim() === '') {
    firstLineIdx++;
  }
  if (firstLineIdx >= lines.length || lines[firstLineIdx].trim() !== 'VMON/1') {
    throw new VpsMonitorError(
      ErrorCodes.PARSE_ERROR,
      `Invalid protocol header: expected "VMON/1", got "${lines[firstLineIdx] ?? 'EOF'}"`
    );
  }

  // 校验末尾标记
  let lastLineIdx = lines.length - 1;
  while (lastLineIdx >= 0 && lines[lastLineIdx].trim() === '') {
    lastLineIdx--;
  }
  if (lastLineIdx < 0 || lines[lastLineIdx].trim() !== '@@end') {
    throw new VpsMonitorError(
      ErrorCodes.PARSE_ERROR,
      'Protocol stream truncated: missing "@@end" trailer marker'
    );
  }

  // 2. 按 @@section 划分段落并检测重复
  const sections = new Map<string, string[]>();
  let currentSection: string | null = null;
  let currentLines: string[] = [];

  for (let i = firstLineIdx + 1; i < lastLineIdx; i++) {
    const line = lines[i];
    const match = line.match(SECTION_HEADER_REGEX);
    if (match) {
      if (currentSection !== null) {
        sections.set(currentSection, currentLines);
      }
      const sectionName = match[1];
      if (sections.has(sectionName)) {
        throw new VpsMonitorError(
          ErrorCodes.PARSE_ERROR,
          `Duplicate section detected in output: @@${sectionName}`
        );
      }
      currentSection = sectionName;
      currentLines = [];
    } else if (currentSection !== null) {
      currentLines.push(line);
    }
  }

  if (currentSection !== null) {
    sections.set(currentSection, currentLines);
  }

  const warnings: string[] = [];

  // 3. 解析各段
  // 3.1 uptime_begin & uptime_end
  const uptimeBeginSec = parseUptime(sections.get('uptime_begin'));
  const uptimeEndSec = parseUptime(sections.get('uptime_end'));

  if (uptimeBeginSec === null) {
    throw new VpsMonitorError(ErrorCodes.PARSE_ERROR, 'Missing or invalid /proc/uptime begin data');
  }

  if (uptimeEndSec !== null) {
    const windowWidth = uptimeEndSec - uptimeBeginSec;
    if (windowWidth > 2.0) {
      warnings.push(`sampling_window_wide:${windowWidth.toFixed(2)}s`);
    } else if (windowWidth < 0) {
      warnings.push('uptime_backwards');
    }
  }

  // 3.2 boot_id
  const bootIdLines = sections.get('boot_id');
  let bootId: string | null = null;
  if (bootIdLines && bootIdLines.length > 0 && !bootIdLines[0].includes('!UNAVAILABLE')) {
    const trimmed = bootIdLines[0].trim();
    if (trimmed.length > 0) {
      bootId = trimmed;
    }
  }

  // 3.3 stat (CPU ticks)
  let cpuTicks: CpuTicks | null = null;
  let detectedCpuCores = 1;
  const statLines = sections.get('stat');
  if (statLines && statLines.length > 0 && !statLines[0].includes('!UNAVAILABLE')) {
    const result = parseStat(statLines);
    if (result) {
      cpuTicks = result.ticks;
      detectedCpuCores = result.cores;
    } else {
      warnings.push('stat_parse_degraded');
    }
  }

  // 3.4 loadavg
  let loadAvg: LoadAvg | null = null;
  const loadLines = sections.get('loadavg');
  if (loadLines && loadLines.length > 0 && !loadLines[0].includes('!UNAVAILABLE')) {
    loadAvg = parseLoadavg(loadLines[0], detectedCpuCores);
    if (!loadAvg) {
      warnings.push('loadavg_parse_degraded');
    }
  }

  // 3.5 meminfo
  let memoryInfo: MemoryInfo | null = null;
  const memLines = sections.get('meminfo');
  if (memLines && memLines.length > 0 && !memLines[0].includes('!UNAVAILABLE')) {
    memoryInfo = parseMeminfo(memLines);
    if (!memoryInfo) {
      warnings.push('meminfo_parse_degraded');
    }
  }

  // 3.6 ifindex
  const ifindexMap = new Map<string, number>();
  const ifindexLines = sections.get('ifindex');
  if (ifindexLines && ifindexLines.length > 0 && !ifindexLines[0].includes('!UNAVAILABLE')) {
    for (const line of ifindexLines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const name = parts[0];
        const idx = parseInt(parts[1], 10);
        if (!isNaN(idx)) {
          ifindexMap.set(name, idx);
        }
      }
    }
  }

  // 3.7 netdev
  const interfaces: InterfaceInfo[] = [];
  const netdevLines = sections.get('netdev');
  if (netdevLines && netdevLines.length > 0 && !netdevLines[0].includes('!UNAVAILABLE')) {
    parseNetdev(netdevLines, ifindexMap, interfaces, warnings);
  }

  // 3.8 df
  const filesystems: FilesystemInfo[] = [];
  const dfLines = sections.get('df');
  if (dfLines && dfLines.length > 0 && !dfLines[0].includes('!UNAVAILABLE')) {
    parseDf(dfLines, filesystems, warnings);
  }

  const capabilities: SampleCapabilities = {
    hasStat: cpuTicks !== null,
    hasMeminfo: memoryInfo !== null,
    hasNetdev: interfaces.length > 0,
    hasDf: filesystems.length > 0,
    hasBootId: bootId !== null,
    hasIfindex: ifindexMap.size > 0
  };

  return {
    protocolVersion: 'VMON/1',
    serverId: options.serverId,
    generation: options.generation,
    sampleSeq: options.sampleSeq,
    receivedAtUtc: options.receivedAtUtc ?? new Date().toISOString(),
    localMonotonicNs: options.localMonotonicNs ?? BigInt(Date.now()) * 1000000n,
    uptimeBeginSec,
    uptimeEndSec: uptimeEndSec ?? uptimeBeginSec,
    bootId,
    cpuTicks,
    loadAvg,
    memoryInfo,
    interfaces,
    filesystems,
    capabilities,
    warnings
  };
}

function parseUptime(lines?: string[]): number | null {
  if (!lines || lines.length === 0 || lines[0].includes('!UNAVAILABLE')) {
    return null;
  }
  const parts = lines[0].trim().split(/\s+/);
  if (parts.length > 0) {
    const val = parseFloat(parts[0]);
    if (!isNaN(val) && val >= 0) {
      return val;
    }
  }
  return null;
}

function parseStat(lines: string[]): { ticks: CpuTicks; cores: number } | null {
  let cpuTotalLine: string | null = null;
  let coreCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('cpu ')) {
      cpuTotalLine = trimmed;
    } else if (/^cpu\d+\s+/.test(trimmed)) {
      coreCount++;
    }
  }

  if (!cpuTotalLine) {
    return null;
  }

  // cpu  user nice system idle iowait irq softirq steal guest guest_nice
  const parts = cpuTotalLine.split(/\s+/).slice(1);
  if (parts.length < 4) {
    return null;
  }

  try {
    const user = BigInt(parts[0] || 0);
    const nice = BigInt(parts[1] || 0);
    const system = BigInt(parts[2] || 0);
    const idle = BigInt(parts[3] || 0);
    const iowait = BigInt(parts[4] || 0);
    const irq = BigInt(parts[5] || 0);
    const softirq = BigInt(parts[6] || 0);
    const steal = BigInt(parts[7] || 0);
    const guest = BigInt(parts[8] || 0);
    const guestNice = BigInt(parts[9] || 0);

    // 遵循规范：guest / guestNice 已包含于 user / nice，不可重复累加
    const total = user + nice + system + idle + iowait + irq + softirq + steal;
    const busy = total - idle - iowait;

    return {
      ticks: {
        user,
        nice,
        system,
        idle,
        iowait,
        irq,
        softirq,
        steal,
        guest,
        guestNice,
        total,
        busy
      },
      cores: coreCount > 0 ? coreCount : 1
    };
  } catch {
    return null;
  }
}

function parseLoadavg(line: string, fallbackCores: number): LoadAvg | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) {
    return null;
  }
  const load1 = parseFloat(parts[0]);
  const load5 = parseFloat(parts[1]);
  const load15 = parseFloat(parts[2]);
  if (isNaN(load1) || isNaN(load5) || isNaN(load15)) {
    return null;
  }

  let runningThreads = 0;
  let totalThreads = 0;
  let lastPid = 0;

  if (parts.length >= 4) {
    const threadParts = parts[3].split('/');
    if (threadParts.length === 2) {
      runningThreads = parseInt(threadParts[0], 10) || 0;
      totalThreads = parseInt(threadParts[1], 10) || 0;
    }
  }

  if (parts.length >= 5) {
    lastPid = parseInt(parts[4], 10) || 0;
  }

  return {
    load1,
    load5,
    load15,
    runningThreads,
    totalThreads,
    lastPid,
    cpuCores: fallbackCores
  };
}

function parseMeminfo(lines: string[]): MemoryInfo | null {
  const map = new Map<string, bigint>();

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    const valPart = rest.split(/\s+/)[0];
    if (valPart) {
      try {
        const kB = BigInt(valPart);
        map.set(key, kB * 1024n); // 转换为 bytes
      } catch {
        // 忽略异常行
      }
    }
  }

  const memTotal = map.get('MemTotal');
  if (memTotal === undefined) {
    return null;
  }

  return {
    memTotal,
    memAvailable: map.has('MemAvailable') ? map.get('MemAvailable')! : null,
    memFree: map.get('MemFree') ?? 0n,
    buffers: map.get('Buffers') ?? 0n,
    cached: map.get('Cached') ?? 0n,
    sReclaimable: map.get('SReclaimable') ?? 0n,
    shmem: map.get('Shmem') ?? 0n,
    swapTotal: map.get('SwapTotal') ?? 0n,
    swapFree: map.get('SwapFree') ?? 0n
  };
}

function parseNetdev(
  lines: string[],
  ifindexMap: Map<string, number>,
  out: InterfaceInfo[],
  warnings: string[]
): void {
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const name = line.slice(0, colonIdx).trim();
    if (!name || name.includes(' ') || name.includes('/')) {
      continue;
    }

    const dataPart = line.slice(colonIdx + 1).trim();
    const fields = dataPart.split(/\s+/);
    // 标准 Linux /proc/net/dev 至少有 16 个计数器
    if (fields.length < 16) {
      warnings.push(`netdev_invalid_fields:${name}`);
      continue;
    }

    try {
      const rxBytes = BigInt(fields[0]);
      const rxPackets = BigInt(fields[1]);
      const rxErrors = BigInt(fields[2]);
      const rxDrops = BigInt(fields[3]);

      const txBytes = BigInt(fields[8]);
      const txPackets = BigInt(fields[9]);
      const txErrors = BigInt(fields[10]);
      const txDrops = BigInt(fields[11]);

      out.push({
        name,
        ifindex: ifindexMap.get(name) ?? null,
        rxBytes,
        txBytes,
        rxPackets,
        txPackets,
        rxErrors,
        txErrors,
        rxDrops,
        txDrops
      });
    } catch {
      warnings.push(`netdev_parse_error:${name}`);
    }
  }
}

function parseDf(
  lines: string[],
  out: FilesystemInfo[],
  warnings: string[]
): void {
  // df -P 输出，跳过第一行表头
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const match = line.match(DF_ROW_REGEX);
    if (!match) {
      warnings.push(`unsupported_mount_line:${line.slice(0, 32)}`);
      continue;
    }

    const [, filesystem, blocksStr, usedStr, availStr, capStr, mountpoint] = match;

    try {
      const blocks = BigInt(blocksStr);
      const used = BigInt(usedStr);
      const avail = BigInt(availStr);
      const capacityPercent = parseInt(capStr, 10);

      out.push({
        filesystem,
        totalBytes: blocks * 1024n,
        usedBytes: used * 1024n,
        availableBytes: avail * 1024n,
        capacityPercent: isNaN(capacityPercent) ? 0 : capacityPercent,
        mountpoint: mountpoint.trim()
      });
    } catch {
      warnings.push(`df_parse_error:${filesystem}`);
    }
  }
}

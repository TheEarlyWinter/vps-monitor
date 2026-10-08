/**
 * 月度流量账本 (TrafficLedger)
 * 实现计费周期计算、幂等增量记录、跨周期与重启 gap 追踪、大整数持久化
 * 遵循技术实施规范第 7 节
 */

import type {
  ServerConfig,
  RawSample,
  TrafficPeriodDTO,
  TrafficCheckpoint,
  AccountingTransaction,
  GapInterval,
  CoverageStatus
} from '../types/index.ts';
import { filterInterfaces } from '../reducer/metrics-reducer.ts';

export class TrafficLedger {
  public readonly serverId: string;
  private accountingEpoch: string;
  private periodStartUtc: string = '';
  private periodEndUtc: string = '';
  private billingTimeZone: string = 'UTC';
  private resetDay: number = 1;

  private observedRx: bigint = 0n;
  private observedTx: bigint = 0n;
  private manualOpening: bigint = 0n;
  private unallocated: bigint = 0n;
  private gapIntervals: GapInterval[] = [];
  private observationStartedAt: string = '';

  private lastCheckpoint: TrafficCheckpoint | null = null;
  private readonly processedTxnIds = new Set<string>();
  private readonly processedTxnQueue: string[] = [];
  private static readonly MAX_PROCESSED_TXN_IDS = 10000;

  constructor(serverId: string, initialEpoch = 'epoch-1') {
    this.serverId = serverId;
    this.accountingEpoch = initialEpoch;
  }

  /**
   * 记录一轮有效原始采样并产出账本增量事务与最新周期快照
   */
  public recordSample(
    sample: RawSample,
    config: ServerConfig,
    runId = 'run-1'
  ): { transactions: AccountingTransaction[]; period: TrafficPeriodDTO } {
    const sampledDate = new Date(sample.receivedAtUtc);
    const { periodStart, periodEnd } = calculateBillingPeriod(
      sampledDate,
      config.resetDay,
      config.billingTimeZone
    );

    const periodStartIso = periodStart.toISOString();
    const periodEndIso = periodEnd.toISOString();

    // 检查是否切换了计费周期。跨周期的两点差额无法可靠归属，必须重新建立基线。
    if (this.periodStartUtc !== periodStartIso || this.periodEndUtc !== periodEndIso) {
      const previousCheckpoint = this.lastCheckpoint;
      if (this.periodStartUtc !== '') {
        this.accountingEpoch = `epoch-${Date.now()}`;
        this.observedRx = 0n;
        this.observedTx = 0n;
        this.unallocated = 0n;
        this.gapIntervals = [];
        this.processedTxnIds.clear();
        this.processedTxnQueue.length = 0;
        this.lastCheckpoint = null;
        if (previousCheckpoint && previousCheckpoint.timestampUtc !== sample.receivedAtUtc) {
          this.gapIntervals.push({
            from: previousCheckpoint.timestampUtc,
            to: sample.receivedAtUtc,
            reason: 'discontinuity'
          });
        }
      }
      this.periodStartUtc = periodStartIso;
      this.periodEndUtc = periodEndIso;
      this.billingTimeZone = config.billingTimeZone;
      this.resetDay = config.resetDay;
    }

    if (!this.observationStartedAt) {
      this.observationStartedAt = sample.receivedAtUtc;
    }

    const selectedInterfaces = filterInterfaces(
      sample.interfaces.map(i => i.name),
      config
    );

    const transactions: AccountingTransaction[] = [];

    // 1. 首次采样或无 checkpoint：仅记录基线，不记当月开机以来的历史流量
    if (!this.lastCheckpoint) {
      this.saveCheckpoint(sample);
      return {
        transactions,
        period: this.toDTO(config)
      };
    }

    const prevCp = this.lastCheckpoint;

    // 2. 检测整机重启 (bootId 改变或 uptime 回退)
    const isReboot =
      (sample.bootId !== null && prevCp.bootId !== null && sample.bootId !== prevCp.bootId) ||
      sample.uptimeBeginSec < prevCp.uptimeSec;

    if (isReboot) {
      this.gapIntervals.push({
        from: prevCp.timestampUtc,
        to: sample.receivedAtUtc,
        reason: 'reboot'
      });
      this.saveCheckpoint(sample);
      return {
        transactions,
        period: this.toDTO(config)
      };
    }

    // 3. 计算每个选中接口的增量，并把接口消失/重建视为缺口。
    const previousSelectedInterfaces = filterInterfaces(
      Object.keys(prevCp.interfaces),
      config
    );
    const interfaceNames = new Set([...previousSelectedInterfaces, ...selectedInterfaces]);
    const gapNames = new Set<string>();
    for (const ifaceName of interfaceNames) {
      const curr = sample.interfaces.find(i => i.name === ifaceName);
      const prev = prevCp.interfaces[ifaceName];
      if (!curr || !prev) {
        gapNames.add(ifaceName);
        this.gapIntervals.push({
          from: prevCp.timestampUtc,
          to: sample.receivedAtUtc,
          reason: 'discontinuity'
        });
      }
    }

    for (const ifaceName of selectedInterfaces) {
      const curr = sample.interfaces.find(i => i.name === ifaceName);
      const prev = prevCp.interfaces[ifaceName];

      if (!curr || !prev || gapNames.has(ifaceName)) {
        continue;
      }

      // 3.1 检测 ifindex 变更
      if (curr.ifindex !== null && prev.ifindex !== null && curr.ifindex !== prev.ifindex) {
        this.gapIntervals.push({
          from: prevCp.timestampUtc,
          to: sample.receivedAtUtc,
          reason: 'ifindex_change'
        });
        continue;
      }

      // 3.2 检测计数器回绕或异常下降
      if (curr.rxBytes < BigInt(prev.rxBytes) || curr.txBytes < BigInt(prev.txBytes)) {
        this.gapIntervals.push({
          from: prevCp.timestampUtc,
          to: sample.receivedAtUtc,
          reason: 'counter_drop'
        });
        continue;
      }

      const deltaRx = curr.rxBytes - BigInt(prev.rxBytes);
      const deltaTx = curr.txBytes - BigInt(prev.txBytes);

      // 唯一增量 ID，保障幂等性与重放防重
      const txnId = `${this.serverId}:${this.accountingEpoch}:${runId}:${sample.generation}:${sample.sampleSeq}:${ifaceName}`;

      if (!this.processedTxnIds.has(txnId)) {
        this.processedTxnIds.add(txnId);
        this.processedTxnQueue.push(txnId);
        while (this.processedTxnQueue.length > TrafficLedger.MAX_PROCESSED_TXN_IDS) {
          const expired = this.processedTxnQueue.shift();
          if (expired) this.processedTxnIds.delete(expired);
        }
        this.observedRx += deltaRx;
        this.observedTx += deltaTx;

        transactions.push({
          txnId,
          serverId: this.serverId,
          accountingEpoch: this.accountingEpoch,
          generation: sample.generation,
          sampleSeq: sample.sampleSeq,
          periodStart: this.periodStartUtc,
          periodEnd: this.periodEndUtc,
          interfaceName: ifaceName,
          deltaRxBytes: deltaRx.toString(),
          deltaTxBytes: deltaTx.toString(),
          unallocatedBytes: '0',
          isGap: false,
          recordedAt: sample.receivedAtUtc
        });
      }
    }

    this.saveCheckpoint(sample);

    return {
      transactions,
      period: this.toDTO(config)
    };
  }

  private saveCheckpoint(sample: RawSample): void {
    const interfaces: TrafficCheckpoint['interfaces'] = {};
    for (const iface of sample.interfaces) {
      interfaces[iface.name] = {
        name: iface.name,
        ifindex: iface.ifindex,
        rxBytes: iface.rxBytes.toString(),
        txBytes: iface.txBytes.toString(),
        recordedAt: sample.receivedAtUtc,
        uptimeSec: sample.uptimeBeginSec
      };
    }

    this.lastCheckpoint = {
      serverId: this.serverId,
      accountingEpoch: this.accountingEpoch,
      generation: sample.generation,
      sampleSeq: sample.sampleSeq,
      bootId: sample.bootId,
      uptimeSec: sample.uptimeBeginSec,
      timestampUtc: sample.receivedAtUtc,
      interfaces
    };
  }

  public toDTO(config: ServerConfig): TrafficPeriodDTO {
    const observedTotal = this.observedRx + this.observedTx;

    let coverageStatus: CoverageStatus = 'observed_only';
    if (this.gapIntervals.length > 0) {
      coverageStatus = 'incomplete';
    } else if (this.lastCheckpoint !== null) {
      coverageStatus = 'continuous_since_enabled';
    }

    return {
      periodStart: this.periodStartUtc,
      periodEnd: this.periodEndUtc,
      billingTimeZone: this.billingTimeZone,
      quotaBytes: config.quotaBytes,
      quotaDirection: config.quotaDirection,
      observedRxBytes: this.observedRx.toString(),
      observedTxBytes: this.observedTx.toString(),
      observedTotalBytes: observedTotal.toString(),
      manualOpeningBytes: this.manualOpening.toString(),
      unallocatedBytes: this.unallocated.toString(),
      gapIntervals: [...this.gapIntervals],
      coverageStatus,
      observationStartedAt: this.observationStartedAt,
      accountingEpoch: this.accountingEpoch
    };
  }

  public exportState(): {
    accountingEpoch: string;
    periodStartUtc: string;
    periodEndUtc: string;
    billingTimeZone: string;
    resetDay: number;
    observedRx: string;
    observedTx: string;
    manualOpening: string;
    unallocated: string;
    gapIntervals: GapInterval[];
    observationStartedAt: string;
    lastCheckpoint: TrafficCheckpoint | null;
  } {
    return {
      accountingEpoch: this.accountingEpoch,
      periodStartUtc: this.periodStartUtc,
      periodEndUtc: this.periodEndUtc,
      billingTimeZone: this.billingTimeZone,
      resetDay: this.resetDay,
      observedRx: this.observedRx.toString(),
      observedTx: this.observedTx.toString(),
      manualOpening: this.manualOpening.toString(),
      unallocated: this.unallocated.toString(),
      gapIntervals: [...this.gapIntervals],
      observationStartedAt: this.observationStartedAt,
      lastCheckpoint: this.lastCheckpoint
    };
  }

  public importState(saved: ReturnType<TrafficLedger['exportState']>): void {
    this.accountingEpoch = saved.accountingEpoch;
    this.periodStartUtc = saved.periodStartUtc;
    this.periodEndUtc = saved.periodEndUtc;
    this.billingTimeZone = saved.billingTimeZone;
    this.resetDay = saved.resetDay;
    this.observedRx = BigInt(saved.observedRx);
    this.observedTx = BigInt(saved.observedTx);
    this.manualOpening = BigInt(saved.manualOpening);
    this.unallocated = BigInt(saved.unallocated);
    this.gapIntervals = [...saved.gapIntervals];
    this.observationStartedAt = saved.observationStartedAt;
    this.lastCheckpoint = saved.lastCheckpoint;
  }
}

/**
 * 确定性计算基于重置日和时区的计费周期区间 [periodStart, periodEnd)
 * 遵循技术实施规范第 7.1 节
 */
export function calculateBillingPeriod(
  date: Date,
  resetDay: number,
  timeZone: string
): { periodStart: Date; periodEnd: Date } {
  // 解析该时区下的当前本地 年、月、日
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });

  const parts = formatter.formatToParts(date);
  let localYear = 0;
  let localMonth = 0; // 1-12
  let localDay = 0;

  for (const part of parts) {
    if (part.type === 'year') localYear = parseInt(part.value, 10);
    if (part.type === 'month') localMonth = parseInt(part.value, 10);
    if (part.type === 'day') localDay = parseInt(part.value, 10);
  }

  // 获得特定年月的实际有效重置日（例如 2 月 28/29 日防溢出）
  const getActualDay = (y: number, m: number, reqDay: number): number => {
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return Math.min(reqDay, daysInMonth);
  };

  let startYear: number;
  let startMonth: number;
  let endYear: number;
  let endMonth: number;

  const currentMonthActualResetDay = getActualDay(localYear, localMonth, resetDay);

  if (localDay < currentMonthActualResetDay) {
    // 处于上个月重置日到本月重置日之间
    startMonth = localMonth - 1;
    startYear = localYear;
    if (startMonth < 1) {
      startMonth = 12;
      startYear--;
    }
    endMonth = localMonth;
    endYear = localYear;
  } else {
    // 处于本月重置日到下个月重置日之间
    startMonth = localMonth;
    startYear = localYear;
    endMonth = localMonth + 1;
    endYear = localYear;
    if (endMonth > 12) {
      endMonth = 1;
      endYear++;
    }
  }

  const actualStartDay = getActualDay(startYear, startMonth, resetDay);
  const actualEndDay = getActualDay(endYear, endMonth, resetDay);

  // 构造 UTC 日期对象（匹配本地 00:00）
  const periodStart = createZonedDate(startYear, startMonth, actualStartDay, 0, 0, 0, timeZone);
  const periodEnd = createZonedDate(endYear, endMonth, actualEndDay, 0, 0, 0, timeZone);

  return { periodStart, periodEnd };
}

function createZonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  // 先用 UTC 构造一个粗略基准
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  
  // 计算目标时区相对于 UTC 的偏移并修正
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });

  const parts = formatter.formatToParts(utcGuess);
  let y = 0, m = 0, d = 0, h = 0, min = 0, s = 0;
  for (const p of parts) {
    if (p.type === 'year') y = parseInt(p.value, 10);
    if (p.type === 'month') m = parseInt(p.value, 10);
    if (p.type === 'day') d = parseInt(p.value, 10);
    if (p.type === 'hour') h = parseInt(p.value, 10);
    if (p.type === 'minute') min = parseInt(p.value, 10);
    if (p.type === 'second') s = parseInt(p.value, 10);
  }

  const asLocal = Date.UTC(y, m - 1, d, h === 24 ? 0 : h, min, s);
  const offsetMs = asLocal - utcGuess.getTime();

  return new Date(utcGuess.getTime() - offsetMs);
}

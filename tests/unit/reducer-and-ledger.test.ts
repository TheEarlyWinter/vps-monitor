import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceSnapshot } from '../../src/reducer/metrics-reducer.ts';
import { TrafficLedger, calculateBillingPeriod } from '../../src/ledger/traffic-ledger.ts';
import type { ServerConfig, RawSample } from '../../src/types/index.ts';

const mockConfig: ServerConfig = {
  id: 'srv-test-1',
  revision: 1,
  name: 'Test Server',
  host: '1.2.3.4',
  port: 22,
  username: 'ubuntu',
  authKind: 'password',
  credentialRef: 'cred-1',
  hostKey: null,
  proxyRef: null,
  networkSelection: 'auto',
  interfaceNames: [],
  quotaBytes: '1099511627776', // 1 TiB
  quotaDirection: 'sum',
  resetDay: 15,
  billingTimeZone: 'America/Los_Angeles',
  enabled: true,
  sampleIntervalMs: 5000
};

function createSample(seq: number, uptime: number, bootId: string = 'boot-1'): RawSample {
  return {
    protocolVersion: 'VMON/1',
    serverId: 'srv-test-1',
    generation: 1,
    sampleSeq: seq,
    receivedAtUtc: new Date(Date.UTC(2026, 9, 8, 10, 0, seq * 5)).toISOString(),
    localMonotonicNs: BigInt(seq) * 5000000000n,
    uptimeBeginSec: uptime,
    uptimeEndSec: uptime + 0.05,
    bootId,
    cpuTicks: {
      user: 1000n + BigInt(seq) * 100n,
      nice: 0n,
      system: 500n + BigInt(seq) * 50n,
      idle: 8000n + BigInt(seq) * 800n,
      iowait: 50n + BigInt(seq) * 5n,
      irq: 0n,
      softirq: 50n + BigInt(seq) * 5n,
      steal: 10n + BigInt(seq) * 1n,
      guest: 0n,
      guestNice: 0n,
      total: 9610n + BigInt(seq) * 961n,
      busy: 1560n + BigInt(seq) * 156n
    },
    loadAvg: {
      load1: 0.5,
      load5: 0.6,
      load15: 0.7,
      runningThreads: 1,
      totalThreads: 100,
      lastPid: 1234,
      cpuCores: 2
    },
    memoryInfo: {
      memTotal: 2000000000n,
      memAvailable: 1200000000n,
      memFree: 500000000n,
      buffers: 100000000n,
      cached: 600000000n,
      sReclaimable: 50000000n,
      shmem: 20000000n,
      swapTotal: 1000000000n,
      swapFree: 900000000n
    },
    interfaces: [
      {
        name: 'lo',
        ifindex: 1,
        rxBytes: 500000n,
        txBytes: 500000n,
        rxPackets: 100n,
        txPackets: 100n,
        rxErrors: 0n,
        txErrors: 0n,
        rxDrops: 0n,
        txDrops: 0n
      },
      {
        name: 'eth0',
        ifindex: 2,
        rxBytes: 10000000n + BigInt(seq) * 500000n,
        txBytes: 20000000n + BigInt(seq) * 300000n,
        rxPackets: 1000n,
        txPackets: 1000n,
        rxErrors: 0n,
        txErrors: 0n,
        rxDrops: 0n,
        txDrops: 0n
      }
    ],
    filesystems: [
      {
        filesystem: '/dev/root',
        totalBytes: 50000000000n,
        usedBytes: 15000000000n,
        availableBytes: 35000000000n,
        capacityPercent: 30,
        mountpoint: '/'
      }
    ],
    capabilities: {
      hasStat: true,
      hasMeminfo: true,
      hasNetdev: true,
      hasDf: true,
      hasBootId: true,
      hasIfindex: true
    },
    warnings: []
  };
}

test('MetricsReducer: 首采 warming_up，二采 valid 计算', () => {
  const sample1 = createSample(1, 100.0);
  const snap1 = reduceSnapshot(sample1, null, mockConfig);

  assert.strictEqual(snap1.collectionHealth, 'warming_up');
  assert.strictEqual(snap1.cpu.busyPercent.quality, 'warming_up');
  assert.strictEqual(snap1.cpu.busyPercent.value, null);
  assert.strictEqual(snap1.network.rxBps.quality, 'warming_up');

  // 第二采 (5秒后)
  const sample2 = createSample(2, 105.0);
  const snap2 = reduceSnapshot(sample2, sample1, mockConfig);

  assert.strictEqual(snap2.collectionHealth, 'collecting');
  assert.strictEqual(snap2.cpu.busyPercent.quality, 'valid');
  assert.ok(snap2.cpu.busyPercent.value !== null && snap2.cpu.busyPercent.value > 0);
  
  // 校验内存 (used = 2000000000 - 1200000000 = 800000000 = 40%)
  assert.strictEqual(snap2.memory.usedBytes.value, '800000000');
  assert.strictEqual(snap2.memory.usedPercent.value, 40);
  assert.strictEqual(snap2.memory.isEstimated, false);

  // 校验 SWAP (used = 1000000000 - 900000000 = 100000000 = 10%)
  assert.strictEqual(snap2.swap.isConfigured, true);
  assert.strictEqual(snap2.swap.usedBytes.value, '100000000');
  assert.strictEqual(snap2.swap.usedPercent.value, 10);

  // 校验网络速率：自动过滤 lo，仅保留 eth0
  // Δrx = 500000 bytes, Δuptime = 5.0s -> 100000 B/s
  assert.deepStrictEqual(snap2.network.activeInterfaces, ['eth0']);
  assert.strictEqual(snap2.network.rxBps.value, '100000');
  assert.strictEqual(snap2.network.txBps.value, '60000');
});

test('MetricsReducer: MemAvailable 缺失 fallback 估算与 SWAP=0', () => {
  const sample1 = createSample(1, 100.0);
  sample1.memoryInfo!.memAvailable = null;
  sample1.memoryInfo!.swapTotal = 0n;
  sample1.memoryInfo!.swapFree = 0n;

  const snap = reduceSnapshot(sample1, null, mockConfig);

  assert.strictEqual(snap.memory.isEstimated, true);
  assert.strictEqual(snap.memory.usedPercent.quality, 'estimated');
  assert.strictEqual(snap.swap.isConfigured, false);
  assert.strictEqual(snap.swap.usedPercent.value, null);
  assert.ok(snap.warnings.includes('mem_available_estimated'));
});

test('TrafficLedger: 计费周期计算与 2 月 31 日边界保护', () => {
  // 正常月份，15 号重置，当前是 10 月 8 号 -> 上月 9 月 15 到 本月 10 月 15
  const d1 = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));
  const p1 = calculateBillingPeriod(d1, 15, 'America/Los_Angeles');
  assert.strictEqual(p1.periodStart.getUTCMonth(), 8); // 9 月
  assert.strictEqual(p1.periodEnd.getUTCMonth(), 9);   // 10 月

  // 闰年 2 月设置 31 号重置保护 -> 2 月实际最后一天应为 29 号
  const leapFeb = new Date(Date.UTC(2024, 1, 10, 12, 0, 0));
  const pLeap = calculateBillingPeriod(leapFeb, 31, 'UTC');
  assert.strictEqual(pLeap.periodStart.getUTCDate(), 31); // 1 月 31
  assert.strictEqual(pLeap.periodEnd.getUTCDate(), 29);   // 2 月 29
});

test('TrafficLedger: 首采基准、连续记账、幂等去重与重启 gap 追踪', () => {
  const ledger = new TrafficLedger('srv-test-1', 'epoch-1');

  // 第 1 采：建立基线，流量计为 0
  const s1 = createSample(1, 100.0);
  const r1 = ledger.recordSample(s1, mockConfig);
  assert.strictEqual(r1.period.observedTotalBytes, '0');
  assert.strictEqual(r1.period.coverageStatus, 'continuous_since_enabled');
  assert.strictEqual(r1.transactions.length, 0);

  // 第 2 采：产生 Δrx=500000, Δtx=300000
  const s2 = createSample(2, 105.0);
  const r2 = ledger.recordSample(s2, mockConfig);
  assert.strictEqual(r2.period.observedRxBytes, '500000');
  assert.strictEqual(r2.period.observedTxBytes, '300000');
  assert.strictEqual(r2.period.observedTotalBytes, '800000');
  assert.strictEqual(r2.transactions.length, 1);

  // 重放 s2：幂等性测试，不双计
  const r2Replay = ledger.recordSample(s2, mockConfig);
  assert.strictEqual(r2Replay.period.observedTotalBytes, '800000');
  assert.strictEqual(r2Replay.transactions.length, 0);

  // 第 3 采：远端机器重启 (bootId 改变，uptime 回退到 10.0)
  const s3 = createSample(3, 10.0, 'boot-rebooted');
  const r3 = ledger.recordSample(s3, mockConfig);
  assert.strictEqual(r3.period.gapIntervals.length, 1);
  assert.strictEqual(r3.period.gapIntervals[0].reason, 'reboot');
  assert.strictEqual(r3.period.coverageStatus, 'incomplete');
  // 重启不应伪造将新计数器相减
  assert.strictEqual(r3.period.observedTotalBytes, '800000');

  // 状态导出与恢复
  const exported = ledger.exportState();
  const restoredLedger = new TrafficLedger('srv-test-1');
  restoredLedger.importState(exported);
  const restoredDTO = restoredLedger.toDTO(mockConfig);
  assert.strictEqual(restoredDTO.observedTotalBytes, '800000');
  assert.strictEqual(restoredDTO.gapIntervals.length, 1);
});

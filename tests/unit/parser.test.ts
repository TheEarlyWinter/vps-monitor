import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVmon1Output } from '../../src/parser/proc-parser.ts';
import {
  REAL_LINUX_VMON1_OUTPUT,
  BUSYBOX_AND_HUGE_COUNTER_FIXTURE
} from '../fixtures/sample-vmon1.ts';
import { ErrorCodes, VpsMonitorError } from '../../src/types/errors.ts';

test('ProcParser: 解析真实 Linux/Debian 12 输出', () => {
  const sample = parseVmon1Output(REAL_LINUX_VMON1_OUTPUT, {
    serverId: 'srv-debian-1',
    generation: 1,
    sampleSeq: 101
  });

  assert.strictEqual(sample.protocolVersion, 'VMON/1');
  assert.strictEqual(sample.serverId, 'srv-debian-1');
  assert.strictEqual(sample.generation, 1);
  assert.strictEqual(sample.sampleSeq, 101);

  // Uptime
  assert.strictEqual(sample.uptimeBeginSec, 108340.61);
  assert.strictEqual(sample.uptimeEndSec, 108340.68);
  assert.strictEqual(sample.bootId, '0bc0262c-85e6-41dd-b1f0-906cba537e57');

  // CPU stat
  assert.ok(sample.cpuTicks);
  assert.strictEqual(sample.cpuTicks.user, 7563746n);
  assert.strictEqual(sample.cpuTicks.nice, 11573n);
  assert.strictEqual(sample.cpuTicks.system, 4008968n);
  assert.strictEqual(sample.cpuTicks.idle, 159929570n);
  assert.strictEqual(sample.cpuTicks.iowait, 49056n);
  assert.strictEqual(sample.cpuTicks.irq, 0n);
  assert.strictEqual(sample.cpuTicks.softirq, 59368n);
  assert.strictEqual(sample.cpuTicks.steal, 0n);
  // 验证 total 计算不包含重复的 guest/guestNice
  const expectedTotal = 7563746n + 11573n + 4008968n + 159929570n + 49056n + 0n + 59368n + 0n;
  assert.strictEqual(sample.cpuTicks.total, expectedTotal);
  assert.strictEqual(sample.cpuTicks.busy, expectedTotal - 159929570n - 49056n);

  // Loadavg & CPU Cores
  assert.ok(sample.loadAvg);
  assert.strictEqual(sample.loadAvg.load1, 3.26);
  assert.strictEqual(sample.loadAvg.load5, 2.22);
  assert.strictEqual(sample.loadAvg.load15, 1.90);
  assert.strictEqual(sample.loadAvg.runningThreads, 2);
  assert.strictEqual(sample.loadAvg.totalThreads, 2727);
  assert.strictEqual(sample.loadAvg.lastPid, 246050);
  assert.strictEqual(sample.loadAvg.cpuCores, 16);

  // Meminfo
  assert.ok(sample.memoryInfo);
  assert.strictEqual(sample.memoryInfo.memTotal, 15242972n * 1024n);
  assert.strictEqual(sample.memoryInfo.memAvailable, 2492756n * 1024n);
  assert.strictEqual(sample.memoryInfo.swapTotal, 4194300n * 1024n);
  assert.strictEqual(sample.memoryInfo.swapFree, 152n * 1024n);

  // Netdev & ifindex
  assert.strictEqual(sample.interfaces.length, 4);
  const eth = sample.interfaces.find(i => i.name === 'enp2s0');
  assert.ok(eth);
  assert.strictEqual(eth.ifindex, 2);
  assert.strictEqual(eth.rxBytes, 5278916018n);
  assert.strictEqual(eth.txBytes, 2720256536n);

  const meta = sample.interfaces.find(i => i.name === 'Meta');
  assert.ok(meta);
  assert.strictEqual(meta.ifindex, 4);
  assert.strictEqual(meta.rxBytes, 2422295488n);

  // Df
  assert.ok(sample.filesystems.length >= 4);
  const rootFs = sample.filesystems.find(f => f.mountpoint === '/');
  assert.ok(rootFs);
  assert.strictEqual(rootFs.filesystem, '/dev/nvme0n1p5');
  assert.strictEqual(rootFs.capacityPercent, 26);
  assert.strictEqual(rootFs.totalBytes, 205307624n * 1024n);

  // 测试空格路径支持
  const spaceFs = sample.filesystems.find(f => f.mountpoint === '/mnt/data with spaces');
  assert.ok(spaceFs);
  assert.strictEqual(spaceFs.filesystem, '/dev/nvme1n1p5');
  assert.strictEqual(spaceFs.capacityPercent, 83);
});

test('ProcParser: BusyBox 格式与超 64 位大整数计数器', () => {
  const sample = parseVmon1Output(BUSYBOX_AND_HUGE_COUNTER_FIXTURE, {
    serverId: 'srv-huge',
    generation: 1,
    sampleSeq: 1
  });

  assert.strictEqual(sample.capabilities.hasBootId, true);
  assert.strictEqual(sample.capabilities.hasDf, true);
  assert.strictEqual(sample.filesystems[0].mountpoint, '/');
  assert.strictEqual(sample.filesystems[0].capacityPercent, 20);

  const iface = sample.interfaces[0];
  assert.strictEqual(iface.name, 'eth0');
  assert.strictEqual(iface.ifindex, 10);
  // 必须精确匹配 18446744073709551615 (2^64-1)，不可因浮点数溢出改变低位
  assert.strictEqual(iface.rxBytes, 18446744073709551615n);
  assert.strictEqual(iface.txBytes, 9223372036854775807n);
});

test('ProcParser: 协议格式错误与截断防护', () => {
  // 1. 缺少 VMON/1 头部
  assert.throws(
    () => parseVmon1Output('invalid header\n@@end', { serverId: '1', generation: 1, sampleSeq: 1 }),
    (err: any) => err instanceof VpsMonitorError && err.code === ErrorCodes.PARSE_ERROR
  );

  // 2. 截断 (缺少 @@end)
  assert.throws(
    () => parseVmon1Output('VMON/1\n@@uptime_begin\n100.0\n', { serverId: '1', generation: 1, sampleSeq: 1 }),
    (err: any) => err instanceof VpsMonitorError && err.code === ErrorCodes.PARSE_ERROR
  );

  // 3. 段重复检测 (@@stat 出现两次)
  const duplicateSections = `VMON/1
@@stat
cpu 1 2 3 4 5 6 7 8
@@stat
cpu 1 2 3 4 5 6 7 8
@@end
`;
  assert.throws(
    () => parseVmon1Output(duplicateSections, { serverId: '1', generation: 1, sampleSeq: 1 }),
    (err: any) => err instanceof VpsMonitorError && err.code === ErrorCodes.PARSE_ERROR
  );
});

test('ProcParser: 控制字符净化与单段不可用降级', () => {
  const outputWithUnavailable = `VMON/1
@@uptime_begin
123.45 200.00\x00\x07
@@boot_id
!UNAVAILABLE
@@stat
cpu  100 20 30 400 5 1 2 0 0 0
@@loadavg
!UNAVAILABLE
@@meminfo
!UNAVAILABLE
@@netdev
!UNAVAILABLE
@@df
!UNAVAILABLE
@@uptime_end
123.50 200.05
@@end
`;

  const sample = parseVmon1Output(outputWithUnavailable, {
    serverId: 'srv-degraded',
    generation: 1,
    sampleSeq: 5
  });

  assert.strictEqual(sample.capabilities.hasBootId, false);
  assert.strictEqual(sample.bootId, null);
  assert.strictEqual(sample.capabilities.hasMeminfo, false);
  assert.strictEqual(sample.memoryInfo, null);
  assert.strictEqual(sample.capabilities.hasDf, false);
  assert.strictEqual(sample.filesystems.length, 0);
  assert.strictEqual(sample.capabilities.hasNetdev, false);
  assert.strictEqual(sample.capabilities.hasStat, true);
  assert.ok(sample.cpuTicks);
});

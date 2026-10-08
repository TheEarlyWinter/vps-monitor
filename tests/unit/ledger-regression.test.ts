import test from 'node:test';
import assert from 'node:assert/strict';
import { TrafficLedger } from '../../src/ledger/traffic-ledger.ts';
import type { RawSample, ServerConfig } from '../../src/types/index.ts';

const config: ServerConfig = {
  id: 'ledger-regression',
  revision: 1,
  name: 'regression',
  host: '127.0.0.1',
  port: 22,
  username: 'root',
  authKind: 'password',
  credentialRef: 'cred-regression',
  hostKey: null,
  proxyRef: null,
  networkSelection: 'auto',
  interfaceNames: [],
  quotaBytes: null,
  quotaDirection: 'sum',
  resetDay: 1,
  billingTimeZone: 'UTC',
  enabled: true,
  sampleIntervalMs: 5000
};

function sample(seq: number, at: string, rxBytes: bigint): RawSample {
  return {
    protocolVersion: 'VMON/1',
    serverId: config.id,
    generation: 1,
    sampleSeq: seq,
    receivedAtUtc: at,
    localMonotonicNs: BigInt(seq),
    uptimeBeginSec: seq * 60,
    uptimeEndSec: seq * 60 + 0.1,
    bootId: 'boot-1',
    cpuTicks: null,
    loadAvg: null,
    memoryInfo: null,
    interfaces: [{
      name: 'eth0',
      ifindex: 2,
      rxBytes,
      txBytes: 0n,
      rxPackets: 0n,
      txPackets: 0n,
      rxErrors: 0n,
      txErrors: 0n,
      rxDrops: 0n,
      txDrops: 0n
    }],
    filesystems: [],
    capabilities: {
      hasStat: false,
      hasMeminfo: false,
      hasNetdev: true,
      hasDf: false,
      hasBootId: true,
      hasIfindex: true
    },
    warnings: []
  };
}

test('TrafficLedger: 跨计费周期只建立新基线，不把跨周期差额计入新周期', () => {
  const ledger = new TrafficLedger(config.id);
  ledger.recordSample(sample(1, '2026-01-31T23:59:00.000Z', 100n), config);
  const result = ledger.recordSample(sample(2, '2026-02-01T00:01:00.000Z', 200n), config);

  assert.strictEqual(result.period.observedRxBytes, '0');
  assert.strictEqual(result.transactions.length, 0);
  assert.strictEqual(result.period.coverageStatus, 'incomplete');
  assert.strictEqual(result.period.gapIntervals[0]?.reason, 'discontinuity');
});

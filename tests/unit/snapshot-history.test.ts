import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SnapshotHistoryStore } from '../../src/history/snapshot-history.ts';
import type { SnapshotDTO } from '../../src/types/index.ts';

function snapshot(at: string, cpu = 10): SnapshotDTO {
  return {
    serverId: 'srv-history',
    seq: 1,
    connectionState: 'online',
    collectionHealth: 'collecting',
    lastSuccessAt: at,
    lastAttemptAt: at,
    nextRetryAt: null,
    sshRequestLatencyMs: 100,
    uptimeSec: { value: 1, quality: 'valid', source: 'test' },
    cpu: {
      busyPercent: { value: cpu, quality: 'valid', source: 'test' },
      stealPercent: { value: 0, quality: 'valid', source: 'test' },
      iowaitPercent: { value: 0, quality: 'valid', source: 'test' },
      cores: 2
    },
    load: {
      load1: { value: 0, quality: 'valid', source: 'test' },
      load5: { value: 0, quality: 'valid', source: 'test' },
      load15: { value: 0, quality: 'valid', source: 'test' }
    },
    memory: {
      totalBytes: { value: '1000', quality: 'valid', source: 'test' },
      usedBytes: { value: '500', quality: 'valid', source: 'test' },
      usedPercent: { value: 50, quality: 'valid', source: 'test' },
      isEstimated: false
    },
    swap: {
      totalBytes: { value: '0', quality: 'valid', source: 'test' },
      usedBytes: { value: '0', quality: 'valid', source: 'test' },
      usedPercent: { value: null, quality: 'valid', source: 'test' },
      isConfigured: false
    },
    filesystems: [{ mountpoint: '/', totalBytes: '1000', usedBytes: '200', availableBytes: '800', usedPercent: 20, isRoot: true }],
    network: {
      rxBps: { value: '10', quality: 'valid', source: 'test' },
      txBps: { value: '20', quality: 'valid', source: 'test' },
      activeInterfaces: ['eth0']
    },
    trafficPeriod: null,
    warnings: []
  } as unknown as SnapshotDTO;
}

test('SnapshotHistoryStore: minute sampling, bounded history, reload, and corruption guard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-history-test-'));
  const filePath = path.join(dir, 'snapshot-history.json');
  try {
    const store = new SnapshotHistoryStore(filePath);
    const t0 = '2026-01-01T00:00:00.000Z';
    assert.equal(store.record('srv-history', snapshot(t0)), true);
    assert.equal(store.record('srv-history', snapshot('2026-01-01T00:00:30.000Z', 20)), false);
    assert.equal(store.record('srv-history', snapshot('2026-01-01T00:01:00.000Z', 30)), true);
    assert.deepEqual(store.get('srv-history', 1).map(item => item.cpuBusyPercent), [30]);

    const reloaded = new SnapshotHistoryStore(filePath);
    assert.equal(reloaded.get('srv-history', 10).length, 2);
    assert.equal(reloaded.get('srv-history', 10)[0].memoryUsedPercent, 50);

    const oversized = Array.from({ length: 1445 }, (_, index) => ({
      at: new Date(Date.parse(t0) + (index + 2) * 60_000).toISOString(),
      cpuBusyPercent: index % 100,
      memoryUsedPercent: 50,
      diskUsedPercent: 20,
      rxBps: '10',
      txBps: '20'
    }));
    fs.writeFileSync(filePath, JSON.stringify({ 'srv-history': oversized }));
    const bounded = new SnapshotHistoryStore(filePath);
    assert.equal(bounded.get('srv-history', 2000).length, 1440);
    assert.equal(bounded.record('srv-history', snapshot('2026-01-02T00:10:00.000Z', 90)), true);
    assert.equal(bounded.get('srv-history', 2000).length, 1440);

    fs.writeFileSync(filePath, '{broken');
    assert.throws(() => new SnapshotHistoryStore(filePath), /Failed to load snapshot history/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

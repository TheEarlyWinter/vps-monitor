import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AlertManager } from '../../src/alerts/alert-manager.ts';
import type { SnapshotDTO } from '../../src/types/index.ts';

function snapshot(cpu: number | null, memory: number | null, disk: number | null): SnapshotDTO {
  return {
    cpu: { busyPercent: { value: cpu } },
    memory: { usedPercent: { value: memory } },
    filesystems: disk === null ? [] : [{ mountpoint: '/', totalBytes: '1', usedBytes: '1', availableBytes: '0', usedPercent: disk, isRoot: true }]
  } as unknown as SnapshotDTO;
}

test('AlertManager: thresholds trigger once, resolve, and survive reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-alert-test-'));
  const filePath = path.join(dir, 'alert-state.json');
  try {
    const manager = new AlertManager(filePath);
    manager.setRules('srv-alert', {
      enabled: true,
      cpuPercent: 80,
      memoryPercent: null,
      diskPercent: 90,
      connectionFailures: 3
    });

    manager.onSnapshot('srv-alert', snapshot(81, 95, 91), '2026-01-01T00:00:00.000Z');
    assert.deepEqual(manager.list('srv-alert').filter(alert => alert.status === 'active').map(alert => alert.kind).sort(), ['cpu', 'disk']);

    manager.onSnapshot('srv-alert', snapshot(99, 95, 99), '2026-01-01T00:00:05.000Z');
    assert.equal(manager.list('srv-alert').length, 2);

    manager.onSnapshot('srv-alert', snapshot(10, 50, 20), '2026-01-01T00:01:00.000Z');
    assert.ok(manager.list('srv-alert').every(alert => alert.status === 'resolved'));
    assert.ok(manager.list('srv-alert').every(alert => alert.resolvedAt));

    const reloaded = new AlertManager(filePath);
    assert.equal(reloaded.list('srv-alert').length, 2);
    assert.equal(reloaded.getRules('srv-alert').memoryPercent, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertManager: connection failures use consecutive threshold and ignore host-key/vault gates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-alert-connection-test-'));
  const filePath = path.join(dir, 'alert-state.json');
  try {
    const manager = new AlertManager(filePath);
    manager.setRules('srv-connection', {
      enabled: true,
      cpuPercent: null,
      memoryPercent: null,
      diskPercent: null,
      connectionFailures: 2
    });

    manager.onError('srv-connection', { code: 'HOST_KEY_CHANGED', message: 'pin changed' }, '2026-01-01T00:00:00.000Z');
    manager.onError('srv-connection', { code: 'CREDENTIAL_LOCKED', message: 'locked' }, '2026-01-01T00:00:05.000Z');
    assert.deepEqual(manager.list('srv-connection'), []);

    manager.onError('srv-connection', { code: 'CONNECT_TIMEOUT', message: 'timeout' }, '2026-01-01T00:00:10.000Z');
    assert.deepEqual(manager.list('srv-connection'), []);
    manager.onError('srv-connection', { code: 'SAMPLE_TIMEOUT', message: 'timeout' }, '2026-01-01T00:00:20.000Z');
    assert.equal(manager.list('srv-connection')[0].status, 'active');

    manager.onSnapshot('srv-connection', snapshot(1, 1, 1), '2026-01-01T00:01:00.000Z');
    assert.equal(manager.list('srv-connection')[0].status, 'resolved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertManager: invalid or corrupt state is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-alert-invalid-test-'));
  const filePath = path.join(dir, 'alert-state.json');
  try {
    const manager = new AlertManager(filePath);
    assert.throws(() => manager.setRules('srv-invalid', {
      enabled: true,
      cpuPercent: 101,
      memoryPercent: null,
      diskPercent: null,
      connectionFailures: 1
    }), /Invalid cpuPercent/);

    fs.writeFileSync(filePath, JSON.stringify({ alerts: { 'srv-invalid:cpu': { status: 'active' } } }));
    assert.throws(() => new AlertManager(filePath), /Failed to load alert state/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

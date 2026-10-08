import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorCodes, VpsMonitorError, type SnapshotDTO } from '../types/index.ts';

export interface SnapshotHistoryPoint {
  at: string;
  cpuBusyPercent: number | null;
  memoryUsedPercent: number | null;
  diskUsedPercent: number | null;
  rxBps: string | null;
  txBps: string | null;
}

const MAX_POINTS_PER_SERVER = 1440;
const MIN_RECORD_INTERVAL_MS = 60_000;

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isHistoryPoint(value: unknown): value is SnapshotHistoryPoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Partial<SnapshotHistoryPoint>;
  return typeof point.at === 'string' && !Number.isNaN(Date.parse(point.at)) &&
    isNullableNumber(point.cpuBusyPercent) &&
    isNullableNumber(point.memoryUsedPercent) &&
    isNullableNumber(point.diskUsedPercent) &&
    isNullableString(point.rxBps) &&
    isNullableString(point.txBps);
}

export class SnapshotHistoryStore {
  private readonly filePath: string;
  private readonly points = new Map<string, SnapshotHistoryPoint[]>();

  public constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  public record(serverId: string, snapshot: SnapshotDTO): boolean {
    const at = snapshot.lastSuccessAt ?? new Date().toISOString();
    const current = this.points.get(serverId) ?? [];
    const last = current[current.length - 1];
    if (last && Date.parse(at) - Date.parse(last.at) < MIN_RECORD_INTERVAL_MS) return false;

    const rootFs = snapshot.filesystems.find(item => item.isRoot) ?? snapshot.filesystems[0];
    const point: SnapshotHistoryPoint = {
      at,
      cpuBusyPercent: snapshot.cpu.busyPercent.value,
      memoryUsedPercent: snapshot.memory.usedPercent.value,
      diskUsedPercent: rootFs?.usedPercent ?? null,
      rxBps: snapshot.network.rxBps.value,
      txBps: snapshot.network.txBps.value
    };
    const next = [...current, point].slice(-MAX_POINTS_PER_SERVER);
    this.points.set(serverId, next);
    this.persist();
    return true;
  }

  public get(serverId: string, limit = 120): SnapshotHistoryPoint[] {
    return (this.points.get(serverId) ?? []).slice(-limit).map(point => ({ ...point }));
  }

  public clear(serverId: string): void {
    if (!this.points.delete(serverId)) return;
    this.persist();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid history root');
      for (const [serverId, value] of Object.entries(parsed)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(serverId) || !Array.isArray(value) || value.some(point => !isHistoryPoint(point))) {
          throw new Error('invalid history point');
        }
        this.points.set(serverId, (value as SnapshotHistoryPoint[]).slice(-MAX_POINTS_PER_SERVER));
      }
    } catch {
      throw new VpsMonitorError(ErrorCodes.STORAGE_ERROR, 'Failed to load snapshot history');
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const fd = fs.openSync(tempPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(Object.fromEntries(this.points.entries())), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}

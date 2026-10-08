import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorCodes, VpsMonitorError, type SnapshotDTO } from '../types/index.ts';

export type AlertKind = 'cpu' | 'memory' | 'disk' | 'connection';
export type AlertStatus = 'active' | 'resolved';

export interface AlertRules {
  enabled: boolean;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  connectionFailures: number;
}

export interface AlertRecord {
  id: string;
  serverId: string;
  kind: AlertKind;
  status: AlertStatus;
  message: string;
  firstTriggeredAt: string;
  lastTransitionAt: string;
  resolvedAt: string | null;
  observedValue: number | null;
  threshold: number | null;
}

interface AlertStateFile {
  rules: Record<string, AlertRules>;
  alerts: Record<string, AlertRecord>;
}

const DEFAULT_ALERT_RULES: AlertRules = {
  enabled: true,
  cpuPercent: 90,
  memoryPercent: 90,
  diskPercent: 90,
  connectionFailures: 3
};

const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALERT_KINDS = new Set<AlertKind>(['cpu', 'memory', 'disk', 'connection']);
const CONNECTION_ALERT_EXCLUDED_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.HOST_KEY_REQUIRED,
  ErrorCodes.HOST_KEY_CHANGED,
  ErrorCodes.CREDENTIAL_LOCKED
]);

export function defaultAlertRules(): AlertRules {
  return { ...DEFAULT_ALERT_RULES };
}

export function normalizeAlertRules(value: unknown, fallback: AlertRules = DEFAULT_ALERT_RULES): AlertRules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid alert rules');
  }
  const raw = value as Partial<AlertRules>;
  return {
    enabled: raw.enabled === undefined ? fallback.enabled : raw.enabled === true,
    cpuPercent: nullableThreshold(raw.cpuPercent, fallback.cpuPercent, 'cpuPercent'),
    memoryPercent: nullableThreshold(raw.memoryPercent, fallback.memoryPercent, 'memoryPercent'),
    diskPercent: nullableThreshold(raw.diskPercent, fallback.diskPercent, 'diskPercent'),
    connectionFailures: positiveInteger(raw.connectionFailures, fallback.connectionFailures, 'connectionFailures', 1, 20)
  };
}

function nullableThreshold(value: unknown, fallback: number | null, field: string): number | null {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 1 || numberValue > 100) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, `Invalid ${field}`);
  }
  return numberValue;
}

function positiveInteger(value: unknown, fallback: number, field: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, `Invalid ${field}`);
  }
  return numberValue;
}

function isAlertRecord(value: unknown): value is AlertRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<AlertRecord>;
  return typeof record.id === 'string' &&
    typeof record.serverId === 'string' && SERVER_ID.test(record.serverId) &&
    typeof record.kind === 'string' && ALERT_KINDS.has(record.kind as AlertKind) &&
    record.id === `${record.serverId}:${record.kind}` &&
    (record.status === 'active' || record.status === 'resolved') &&
    typeof record.message === 'string' && record.message.length <= 500 &&
    typeof record.firstTriggeredAt === 'string' && !Number.isNaN(Date.parse(record.firstTriggeredAt)) &&
    typeof record.lastTransitionAt === 'string' && !Number.isNaN(Date.parse(record.lastTransitionAt)) &&
    (record.status === 'active' ? record.resolvedAt === null : typeof record.resolvedAt === 'string' && !Number.isNaN(Date.parse(record.resolvedAt))) &&
    (record.observedValue === null || (typeof record.observedValue === 'number' && Number.isFinite(record.observedValue))) &&
    (record.threshold === null || (typeof record.threshold === 'number' && Number.isFinite(record.threshold)));
}

export class AlertManager {
  private readonly filePath: string;
  private readonly rules = new Map<string, AlertRules>();
  private readonly alerts = new Map<string, AlertRecord>();
  private readonly failureCounts = new Map<string, number>();

  public constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  public getRules(serverId: string): AlertRules {
    return { ...(this.rules.get(serverId) ?? DEFAULT_ALERT_RULES) };
  }

  public setRules(serverId: string, value: unknown): AlertRules {
    const next = normalizeAlertRules(value, this.getRules(serverId));
    this.rules.set(serverId, next);
    this.failureCounts.set(serverId, 0);
    if (!next.enabled) {
      const now = new Date().toISOString();
      for (const alert of this.alerts.values()) {
        if (alert.serverId === serverId && alert.status === 'active') {
          this.resolveRecord(alert, now, '告警规则已禁用');
        }
      }
    }
    this.persist();
    return { ...next };
  }

  public onSnapshot(serverId: string, snapshot: SnapshotDTO, at = new Date().toISOString()): void {
    const rules = this.getRules(serverId);
    this.failureCounts.set(serverId, 0);
    if (!rules.enabled) return;

    let changed = this.resolveIfActive(serverId, 'connection', at, '连接已恢复');
    changed = this.evaluateThreshold(serverId, 'cpu', snapshot.cpu.busyPercent.value, rules.cpuPercent, at) || changed;
    changed = this.evaluateThreshold(serverId, 'memory', snapshot.memory.usedPercent.value, rules.memoryPercent, at) || changed;
    const rootFs = snapshot.filesystems.find(item => item.isRoot) ?? snapshot.filesystems[0];
    changed = this.evaluateThreshold(serverId, 'disk', rootFs?.usedPercent ?? null, rules.diskPercent, at) || changed;
    if (changed) this.persist();
  }

  public onError(serverId: string, error: { code: string; message: string }, at = new Date().toISOString()): void {
    const rules = this.getRules(serverId);
    if (!rules.enabled) return;
    if (CONNECTION_ALERT_EXCLUDED_CODES.has(error.code)) {
      this.failureCounts.set(serverId, 0);
      if (this.resolveIfActive(serverId, 'connection', at, `连接状态需人工处理（${error.code}）`)) this.persist();
      return;
    }

    const count = (this.failureCounts.get(serverId) ?? 0) + 1;
    this.failureCounts.set(serverId, count);
    if (count < rules.connectionFailures) return;

    const id = this.alertId(serverId, 'connection');
    const existing = this.alerts.get(id);
    if (existing?.status === 'active') return;
    this.alerts.set(id, {
      id,
      serverId,
      kind: 'connection',
      status: 'active',
      message: `连续 ${count} 次采样失败（${error.code}）`,
      firstTriggeredAt: at,
      lastTransitionAt: at,
      resolvedAt: null,
      observedValue: count,
      threshold: rules.connectionFailures
    });
    this.persist();
  }

  public list(serverId?: string): AlertRecord[] {
    return Array.from(this.alerts.values())
      .filter(alert => serverId === undefined || alert.serverId === serverId)
      .sort((a, b) => Date.parse(b.lastTransitionAt) - Date.parse(a.lastTransitionAt))
      .map(alert => ({ ...alert }));
  }

  public removeServer(serverId: string): void {
    let changed = this.rules.delete(serverId) || this.failureCounts.delete(serverId);
    for (const [id, alert] of this.alerts.entries()) {
      if (alert.serverId === serverId) {
        this.alerts.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private evaluateThreshold(
    serverId: string,
    kind: Exclude<AlertKind, 'connection'>,
    value: number | null,
    threshold: number | null,
    at: string
  ): boolean {
    const id = this.alertId(serverId, kind);
    const existing = this.alerts.get(id);
    const breached = threshold !== null && value !== null && value >= threshold;
    if (breached) {
      if (existing?.status === 'active') return false;
      this.alerts.set(id, {
        id,
        serverId,
        kind,
        status: 'active',
        message: `${this.label(kind)} ${value.toFixed(1)}% ≥ ${threshold}%`,
        firstTriggeredAt: at,
        lastTransitionAt: at,
        resolvedAt: null,
        observedValue: value,
        threshold
      });
      return true;
    }
    return this.resolveIfActive(serverId, kind, at, '指标已恢复');
  }

  private resolveIfActive(serverId: string, kind: AlertKind, at: string, message: string): boolean {
    const alert = this.alerts.get(this.alertId(serverId, kind));
    if (!alert || alert.status !== 'active') return false;
    this.resolveRecord(alert, at, message);
    return true;
  }

  private resolveRecord(alert: AlertRecord, at: string, message: string): void {
    alert.status = 'resolved';
    alert.message = message;
    alert.lastTransitionAt = at;
    alert.resolvedAt = at;
  }

  private label(kind: Exclude<AlertKind, 'connection'>): string {
    return kind === 'cpu' ? 'CPU 使用率' : kind === 'memory' ? '内存使用率' : '系统盘使用率';
  }

  private alertId(serverId: string, kind: AlertKind): string {
    return `${serverId}:${kind}`;
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<AlertStateFile>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid alert root');
      if (parsed.rules !== undefined) {
        if (!parsed.rules || typeof parsed.rules !== 'object' || Array.isArray(parsed.rules)) throw new Error('invalid alert rules root');
        for (const [serverId, rules] of Object.entries(parsed.rules)) {
          if (!SERVER_ID.test(serverId)) throw new Error('invalid alert rule server id');
          this.rules.set(serverId, normalizeAlertRules(rules));
        }
      }
      if (parsed.alerts !== undefined) {
        if (!parsed.alerts || typeof parsed.alerts !== 'object' || Array.isArray(parsed.alerts)) throw new Error('invalid alert records root');
        for (const [id, alert] of Object.entries(parsed.alerts)) {
          if (!isAlertRecord(alert) || alert.id !== id) throw new Error('invalid alert record');
          this.alerts.set(id, alert);
        }
      }
    } catch {
      throw new VpsMonitorError(ErrorCodes.STORAGE_ERROR, 'Failed to load alert state');
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const fd = fs.openSync(tempPath, 'w', 0o600);
    try {
      const data: AlertStateFile = {
        rules: Object.fromEntries(this.rules.entries()),
        alerts: Object.fromEntries(this.alerts.entries())
      };
      fs.writeFileSync(fd, JSON.stringify(data), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}

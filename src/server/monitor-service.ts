/**
 * 监控协调服务 (MonitorService)
 * 调度多台服务器采集、状态流转与快照订阅
 * 遵循技术实施规范第 3、8 节
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ErrorCodes,
  VpsMonitorError,
  type ServerConfig,
  type SnapshotDTO,
  type HostKeyPin,
  toPublicServerDTO,
  type PublicServerDTO
} from '../types/index.ts';
import { ServerRepository } from './server-repository.ts';
import { CredentialVault } from '../vault/credential-vault.ts';
import { TrafficLedger } from '../ledger/traffic-ledger.ts';
import { SnapshotHistoryStore, type SnapshotHistoryPoint } from '../history/snapshot-history.ts';
import { CollectorEngine } from '../collector/collector-engine.ts';
import { UnavailableSshTransport } from '../collector/ssh-transport.ts';
import type { SshTransport } from '../collector/ssh-transport.ts';

export type TransportFactory = (config: ServerConfig) => SshTransport;
type LedgerState = ReturnType<TrafficLedger['exportState']>;
type ConnectionErrorDTO = {
  code: string;
  message: string;
  at: string;
};

export class MonitorService {
  public readonly repo: ServerRepository;
  public readonly vault: CredentialVault;
  private readonly transportFactory: TransportFactory;
  private readonly ledgerStatePath: string;
  private readonly history: SnapshotHistoryStore;
  private readonly ledgerStates = new Map<string, LedgerState>();

  private readonly engines = new Map<string, CollectorEngine>();
  private readonly ledgers = new Map<string, TrafficLedger>();
  private readonly intervals = new Map<string, NodeJS.Timeout>();
  private readonly pendingHostKeys = new Map<string, HostKeyPin>();
  private readonly lastErrors = new Map<string, ConnectionErrorDTO>();

  constructor(
    storageDir: string,
    vault: CredentialVault,
    transportFactory?: TransportFactory
  ) {
    this.repo = new ServerRepository(storageDir);
    this.vault = vault;
    this.transportFactory = transportFactory ?? this.defaultTransportFactory;
    this.ledgerStatePath = path.join(storageDir, 'ledger-states.json');
    this.history = new SnapshotHistoryStore(path.join(storageDir, 'snapshot-history.json'));
    this.loadLedgerStates();
  }

  private defaultTransportFactory = (_config: ServerConfig): SshTransport => {
    // 不在生产默认路径展示测试夹具或伪造在线状态。
    // 真正的 SSH 传输必须由已获 Hana 网络授权的运行时注入。
    return new UnavailableSshTransport();
  };

  public async initialize(): Promise<void> {
    if (!this.vault.isUnlocked()) return;
    const servers = this.repo.list();
    for (const server of servers) {
      if (server.enabled) {
        await this.startServerCollector(server);
      }
    }
  }

  public async initializeVault(masterPassword: string): Promise<void> {
    this.vault.initialize(masterPassword);
    await this.initialize();
  }

  public async unlockVault(masterPassword: string): Promise<void> {
    this.vault.unlock(masterPassword);
    await this.initialize();
  }

  public async lockVault(): Promise<void> {
    await this.stopAll();
    this.vault.lock();
  }

  public listPublicServers(): PublicServerDTO[] {
    return this.repo.list().map(s => toPublicServerDTO(s, this.vault.hasCredential(s.credentialRef)));
  }

  public getServer(id: string): ServerConfig | null {
    return this.repo.get(id);
  }

  public async saveServer(config: ServerConfig, expectedRevision?: number): Promise<PublicServerDTO> {
    const saved = this.repo.save(config, expectedRevision);
    if (saved.enabled && this.vault.isUnlocked()) {
      await this.restartServerCollector(saved);
    } else {
      await this.stopServerCollector(saved.id);
    }
    return toPublicServerDTO(saved, this.vault.hasCredential(saved.credentialRef));
  }

  public async deleteServer(id: string): Promise<boolean> {
    const existing = this.repo.get(id);
    await this.stopServerCollector(id);
    if (existing) {
      this.vault.deleteCredential(existing.credentialRef);
    }
    this.ledgers.delete(id);
    this.ledgerStates.delete(id);
    this.persistLedgerStates();
    this.pendingHostKeys.delete(id);
    this.lastErrors.delete(id);
    this.history.clear(id);
    return this.repo.delete(id);
  }

  public getPendingHostKey(id: string): HostKeyPin | null {
    return this.pendingHostKeys.get(id) ?? null;
  }

  public getLastError(id: string): ConnectionErrorDTO | null {
    return this.lastErrors.get(id) ?? null;
  }

  public getHistory(id: string, limit = 120): SnapshotHistoryPoint[] {
    return this.history.get(id, limit);
  }

  public async confirmHostKey(id: string, _hostKeyPin: HostKeyPin): Promise<SnapshotDTO | null> {
    const server = this.repo.get(id);
    const pending = this.pendingHostKeys.get(id);
    if (!server || !pending) {
      throw new VpsMonitorError(
        ErrorCodes.HOST_KEY_REQUIRED,
        'No pending host-key challenge exists'
      );
    }

    // 只允许确认当前挑战中的完整 key 摘要，避免 UI/API 任意改 pin。
    if (
      _hostKeyPin.algorithm !== pending.algorithm ||
      _hostKeyPin.publicKeyBlob !== pending.publicKeyBlob ||
      _hostKeyPin.fingerprintSha256 !== pending.fingerprintSha256
    ) {
      throw new VpsMonitorError(
        ErrorCodes.HOST_KEY_CHANGED,
        'Host-key confirmation does not match the pending challenge'
      );
    }

    server.hostKey = pending;
    this.repo.save(server, server.revision);
    this.pendingHostKeys.delete(id);

    const engine = this.engines.get(id);
    if (engine) {
      await engine.confirmHostKey(pending);
      return engine.getLatestSnapshot();
    }
    return null;
  }

  public getSnapshot(id: string): SnapshotDTO | null {
    // A stale/previous snapshot must never appear online while a new host-key
    // challenge is pending. The challenge takes precedence over cached data.
    if (this.pendingHostKeys.has(id)) return null;
    const engine = this.engines.get(id);
    return engine ? engine.getLatestSnapshot() : null;
  }

  public getAllSnapshots(): SnapshotDTO[] {
    const snapshots: SnapshotDTO[] = [];
    for (const [id, engine] of this.engines.entries()) {
      if (this.pendingHostKeys.has(id)) continue;
      const snap = engine.getLatestSnapshot();
      if (snap) snapshots.push(snap);
    }
    return snapshots;
  }

  public async triggerSample(id: string): Promise<SnapshotDTO | null> {
    if (!this.vault.isUnlocked()) return null;
    const engine = this.engines.get(id);
    if (!engine) {
      const server = this.repo.get(id);
      if (!server || !server.enabled) return null;
      await this.startServerCollector(server);
      return this.engines.get(id)?.stepSample() ?? null;
    }
    return engine.stepSample();
  }

  private async startServerCollector(config: ServerConfig): Promise<void> {
    if (!this.vault.isUnlocked()) return;
    await this.stopServerCollector(config.id);

    let ledger = this.ledgers.get(config.id);
    if (!ledger) {
      ledger = new TrafficLedger(config.id);
      const savedState = this.ledgerStates.get(config.id);
      if (savedState) ledger.importState(savedState);
      this.ledgers.set(config.id, ledger);
    }

    const activeLedger = ledger;
    const transport = this.transportFactory(config);
    const engine = new CollectorEngine(config, this.vault, activeLedger, transport, {
      onSnapshot: (snapshot) => {
        this.lastErrors.delete(config.id);
        this.persistLedger(config.id, activeLedger);
        this.history.record(config.id, snapshot);
      },
      onHostKeyRequired: (sId, hk) => {
        this.pendingHostKeys.set(sId, hk);
        this.lastErrors.set(sId, {
          code: ErrorCodes.HOST_KEY_REQUIRED,
          message: 'Host key confirmation is required',
          at: new Date().toISOString()
        });
      },
      onError: (sId, error) => {
        this.lastErrors.set(sId, {
          code: error.code,
          message: error.message,
          at: new Date().toISOString()
        });
      }
    });

    this.engines.set(config.id, engine);

    if (this.vault.hasCredential(config.credentialRef)) {
      await engine.stepSample();
    }

    const intervalMs = config.sampleIntervalMs || 5000;
    const timer = setInterval(async () => {
      try {
        await engine.stepSample();
      } catch {
        // 异常已由 engine 内部状态机处理
      }
    }, intervalMs);

    this.intervals.set(config.id, timer);
  }

  private async restartServerCollector(config: ServerConfig): Promise<void> {
    await this.startServerCollector(config);
  }

  private async stopServerCollector(id: string): Promise<void> {
    const timer = this.intervals.get(id);
    if (timer) {
      clearInterval(timer);
      this.intervals.delete(id);
    }

    const ledger = this.ledgers.get(id);
    if (ledger) this.persistLedger(id, ledger);

    const engine = this.engines.get(id);
    if (engine) {
      await engine.stop();
      this.engines.delete(id);
    }
  }

  public async stopAll(): Promise<void> {
    for (const id of Array.from(this.engines.keys())) {
      await this.stopServerCollector(id);
    }
  }

  private loadLedgerStates(): void {
    if (!fs.existsSync(this.ledgerStatePath)) return;
    try {
      const raw = fs.readFileSync(this.ledgerStatePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, LedgerState>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid ledger state root');
      }
      for (const [serverId, state] of Object.entries(parsed)) {
        if (state && typeof state === 'object') {
          this.ledgerStates.set(serverId, state);
        }
      }
      fs.chmodSync(this.ledgerStatePath, 0o600);
    } catch {
      throw new VpsMonitorError(ErrorCodes.STORAGE_ERROR, 'Failed to load ledger state');
    }
  }

  private persistLedger(serverId: string, ledger: TrafficLedger): void {
    this.ledgerStates.set(serverId, ledger.exportState());
    this.persistLedgerStates();
  }

  private persistLedgerStates(): void {
    const tempFile = `${this.ledgerStatePath}.tmp.${process.pid}.${Date.now()}`;
    const fd = fs.openSync(tempFile, 'w', 0o600);
    try {
      // Hana 的 Node Permission Model 禁用 fsync API；保持临时文件 + rename 的原子替换，
      // 不调用被运行时拒绝的 fsyncSync，避免锁库/停止采集器返回 500。
      fs.writeFileSync(
        fd,
        JSON.stringify(Object.fromEntries(this.ledgerStates.entries()), null, 2),
        'utf8'
      );
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, this.ledgerStatePath);
    fs.chmodSync(this.ledgerStatePath, 0o600);
  }
}

/**
 * 采集引擎与连接状态机 (CollectorEngine)
 * 遵循技术实施规范第 5.2、8.1 节
 */

import { Buffer } from 'node:buffer';
import {
  ErrorCodes,
  VpsMonitorError,
  type ServerConfig,
  type RawSample,
  type SnapshotDTO,
  type ConnectionState,
  type CollectionHealth,
  type HostKeyPin
} from '../types/index.ts';
import { parseVmon1Output } from '../parser/proc-parser.ts';
import { reduceSnapshot } from '../reducer/metrics-reducer.ts';
import { TrafficLedger } from '../ledger/traffic-ledger.ts';
import type { CredentialVault } from '../vault/credential-vault.ts';
import type { SshTransport } from './ssh-transport.ts';

// 规范第 5.2 节严格约定的单物理行命令
export const VMON1_FIXED_COMMAND =
  "LC_ALL=C; export LC_ALL; r(){ printf '@@%s\\n' \"$1\"; if [ -r \"$2\" ]; then cat \"$2\" 2>/dev/null || printf '!UNAVAILABLE\\n'; else printf '!UNAVAILABLE\\n'; fi; }; printf 'VMON/1\\n'; r uptime_begin /proc/uptime; r boot_id /proc/sys/kernel/random/boot_id; r stat /proc/stat; r loadavg /proc/loadavg; r meminfo /proc/meminfo; r netdev /proc/net/dev; printf '@@ifindex\\n'; for p in /sys/class/net/*/ifindex; do [ -r \"$p\" ] || continue; n=${p%/ifindex}; n=${n##*/}; printf '%s ' \"$n\"; cat \"$p\" 2>/dev/null || printf '!UNAVAILABLE\\n'; done; printf '@@df\\n'; df -P -k -l 2>/dev/null || printf '!UNAVAILABLE\\n'; r uptime_end /proc/uptime; printf '@@end\\n'";

const MAX_EXEC_OUTPUT_BYTES = 256 * 1024;

export interface CollectorEvents {
  onSnapshot?: (snapshot: SnapshotDTO) => void;
  onHostKeyRequired?: (serverId: string, hostKey: HostKeyPin) => void;
  onError?: (serverId: string, error: VpsMonitorError) => void;
}

export class CollectorEngine {
  public config: ServerConfig;
  private readonly vault: CredentialVault;
  private readonly ledger: TrafficLedger;
  private readonly transport: SshTransport;
  private readonly events: CollectorEvents;

  private connectionState: ConnectionState = 'disabled';
  private collectionHealth: CollectionHealth = 'warming_up';
  private sampleSeq = 0;
  private generation = 1;
  private isSampling = false;
  private retryCount = 0;
  private nextRetryTimestamp: number | null = null;
  private stopped = false;

  private previousSample: RawSample | null = null;
  private latestSnapshot: SnapshotDTO | null = null;

  constructor(
    config: ServerConfig,
    vault: CredentialVault,
    ledger: TrafficLedger,
    transport: SshTransport,
    events: CollectorEvents = {}
  ) {
    this.config = config;
    this.vault = vault;
    this.ledger = ledger;
    this.transport = transport;
    this.events = events;

    if (this.config.enabled) {
      this.connectionState = 'connecting';
    } else {
      this.connectionState = 'disabled';
    }
  }

  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  public getLatestSnapshot(): SnapshotDTO | null {
    return this.latestSnapshot;
  }

  /**
   * 执行一次采样周期（包含建连、指纹比对、固定命令执行、差分与账本记录）
   */
  public async stepSample(): Promise<SnapshotDTO | null> {
    if (this.stopped || !this.config.enabled) {
      this.connectionState = 'disabled';
      return null;
    }

    if (this.nextRetryTimestamp !== null && Date.now() < this.nextRetryTimestamp) {
      return this.latestSnapshot;
    }

    if (this.isSampling) {
      // 避免单机重叠采样
      return this.latestSnapshot;
    }

    this.isSampling = true;
    const runGeneration = this.generation;

    try {
      // 1. 锁定状态下立即断开现有会话，不能继续复用已认证连接。
      if (!this.vault.isUnlocked()) {
        this.connectionState = 'credential_locked';
        await this.transport.disconnect().catch(() => undefined);
        throw new VpsMonitorError(ErrorCodes.CREDENTIAL_LOCKED, 'Vault is locked');
      }

      // 2. 首次连接只探测主机指纹，不取得、不提交任何凭据。
      if (!this.config.hostKey) {
        this.connectionState = 'connecting';
        const connectResult = await this.transport.connect({
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          expectedHostKeyPin: null,
          verifyHostKeyOnly: true,
          timeoutMs: 15000
        });
        await this.transport.disconnect().catch(() => undefined);
        if (runGeneration !== this.generation || this.stopped) return this.latestSnapshot;

        this.connectionState = 'host_key_required';
        this.events.onHostKeyRequired?.(this.config.id, connectResult.actualHostKey);
        return null;
      }

      if (!this.vault.hasCredential(this.config.credentialRef)) {
        this.connectionState = 'credential_locked';
        throw new VpsMonitorError(
          ErrorCodes.CREDENTIAL_LOCKED,
          'Credential is unavailable'
        );
      }

      const cred = this.vault.getCredential(this.config.credentialRef);

      // 3. 检查连接状态并按需建立已认证连接。
      if (!this.transport.isConnected()) {
        this.connectionState = 'connecting';
        const connectResult = await this.transport.connect({
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          auth: {
            kind: this.config.authKind,
            secret: cred.secret,
            passphrase: cred.passphrase
          },
          expectedHostKeyPin: this.config.hostKey,
          verifyHostKeyOnly: false,
          timeoutMs: 15000
        });

        if (!connectResult.pinMatched) {
          await this.transport.disconnect().catch(() => undefined);
          // 保留 host_key_changed 状态，同时暴露实际候选指纹；只有用户显式确认后才更新 pin。
          this.events.onHostKeyRequired?.(this.config.id, connectResult.actualHostKey);
          throw new VpsMonitorError(
            ErrorCodes.HOST_KEY_CHANGED,
            'Host key verification failed'
          );
        }
      }
      this.connectionState = 'online';

      if (runGeneration !== this.generation || this.stopped) return this.latestSnapshot;

      // 4. 执行固定单行采集命令
      const execStart = Date.now();
      const execResult = await this.transport.exec(VMON1_FIXED_COMMAND, 8000);
      const latencyMs = Date.now() - execStart;
      if (runGeneration !== this.generation || this.stopped) return this.latestSnapshot;
      if (execResult.exitCode !== 0) {
        throw new VpsMonitorError(
          ErrorCodes.PARSE_ERROR,
          'Remote collector command failed'
        );
      }
      if (Buffer.byteLength(execResult.stdout, 'utf8') > MAX_EXEC_OUTPUT_BYTES) {
        throw new VpsMonitorError(
          ErrorCodes.OUTPUT_LIMIT,
          'Remote collector output exceeded the limit'
        );
      }

      // 5. 解析输出
      this.sampleSeq++;
      const sample = parseVmon1Output(execResult.stdout, {
        serverId: this.config.id,
        generation: this.generation,
        sampleSeq: this.sampleSeq,
        receivedAtUtc: new Date().toISOString()
      });

      // 5. 差分计算与指标还原
      const currentSnap = reduceSnapshot(sample, this.previousSample, this.config, {
        connectionState: this.connectionState,
        collectionHealth: this.collectionHealth,
        sshRequestLatencyMs: latencyMs
      });

      // 6. 记入流量账本
      const ledgerResult = this.ledger.recordSample(sample, this.config);
      currentSnap.trafficPeriod = ledgerResult.period;

      // 7. 更新状态与缓存
      this.previousSample = sample;
      this.latestSnapshot = currentSnap;
      this.collectionHealth = currentSnap.collectionHealth;
      this.retryCount = 0; // 重置退避计数
      this.nextRetryTimestamp = null;

      this.events.onSnapshot?.(currentSnap);
      return currentSnap;
    } catch (err: any) {
      await this.handleSampleError(err);
      return null;
    } finally {
      this.isSampling = false;
    }
  }

  private async handleSampleError(err: any): Promise<void> {
    const error = err instanceof VpsMonitorError
      ? err
      : new VpsMonitorError(ErrorCodes.SAMPLE_TIMEOUT, 'Sample failed');

    if (error.code === ErrorCodes.HOST_KEY_CHANGED) {
      this.connectionState = 'host_key_changed';
      await this.transport.disconnect().catch(() => undefined);
    } else if (error.code === ErrorCodes.AUTH_FAILED) {
      this.connectionState = 'auth_failed';
      await this.transport.disconnect().catch(() => undefined);
    } else if (error.code === ErrorCodes.CREDENTIAL_LOCKED) {
      this.connectionState = 'credential_locked';
      await this.transport.disconnect().catch(() => undefined);
    } else {
      // 网络、超时、输出或解析错误均必须释放会话，下一轮才能重连。
      await this.transport.disconnect().catch(() => undefined);
      this.connectionState = 'retry_wait';
      this.scheduleBackoff();
    }

    if (this.latestSnapshot) {
      this.latestSnapshot.collectionHealth = 'stale';
      this.latestSnapshot.connectionState = this.connectionState;
      this.latestSnapshot.nextRetryAt = this.nextRetryTimestamp
        ? new Date(this.nextRetryTimestamp).toISOString()
        : null;
    }

    this.events.onError?.(this.config.id, error);
  }

  private scheduleBackoff(): void {
    // 指数退避：base 2s, 2^N, max 120s, 50%~100% jitter
    this.retryCount++;
    const baseDelay = Math.min(120, 2 * Math.pow(2, this.retryCount - 1));
    const jitterFactor = 0.5 + Math.random() * 0.5;
    const delaySec = baseDelay * jitterFactor;
    this.nextRetryTimestamp = Date.now() + Math.round(delaySec * 1000);
  }

  public async confirmHostKey(confirmedPin: HostKeyPin): Promise<void> {
    if (this.stopped) return;
    this.config.hostKey = confirmedPin;
    this.config.revision++;
    this.connectionState = 'connecting';
    await this.stepSample();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.connectionState = 'stopping';
    await this.transport.disconnect().catch(() => undefined);
    this.connectionState = 'disabled';
  }
}

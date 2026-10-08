/**
 * 服务器配置持久化仓库 (ServerRepository)
 * 遵循技术实施规范第 2.3、3 节
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ErrorCodes,
  VpsMonitorError,
  type ServerConfig
} from '../types/index.ts';

export class ServerRepository {
  private readonly storageDir: string;
  private readonly filePath: string;
  private readonly servers = new Map<string, ServerConfig>();

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    this.filePath = path.join(storageDir, 'servers.json');
    this.ensureDir();
    this.load();
  }

  public list(): ServerConfig[] {
    return Array.from(this.servers.values());
  }

  public get(id: string): ServerConfig | null {
    return this.servers.get(id) ?? null;
  }

  public save(config: ServerConfig, expectedRevision?: number): ServerConfig {
    const existing = this.servers.get(config.id);
    if (existing) {
      if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
        throw new VpsMonitorError(
          ErrorCodes.CONFIG_CONFLICT,
          `Config revision conflict: expected ${expectedRevision}, actual ${existing.revision}`
        );
      }
      config.revision = existing.revision + 1;
    } else {
      config.revision = 1;
    }

    this.servers.set(config.id, { ...config });
    this.persist();
    return this.servers.get(config.id)!;
  }

  public delete(id: string): boolean {
    const deleted = this.servers.delete(id);
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  private ensureDir(): void {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
      }
      fs.chmodSync(this.storageDir, 0o700);
    } catch {
      throw new VpsMonitorError(
        ErrorCodes.STORAGE_ERROR,
        'Unable to enforce secure monitor directory permissions'
      );
    }
  }

  private persist(): void {
    const list = Array.from(this.servers.values());
    const tempFile = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const fd = fs.openSync(tempFile, 'w', 0o600);
    try {
      // Hana 的 Node Permission Model 禁用 fsync API；保留临时文件 + rename 的原子替换。
      fs.writeFileSync(fd, JSON.stringify(list, null, 2), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      fs.chmodSync(this.filePath, 0o600);
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const list = JSON.parse(raw) as ServerConfig[];
      if (Array.isArray(list)) {
        for (const item of list) {
          this.servers.set(item.id, item);
        }
      }
    } catch {
      throw new VpsMonitorError(ErrorCodes.STORAGE_ERROR, 'Failed to parse servers.json');
    }
  }
}

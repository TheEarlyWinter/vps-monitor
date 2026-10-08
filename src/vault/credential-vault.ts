/**
 * 本地安全凭据库 (CredentialVault)
 * 实现 scrypt KEK + AES-256-GCM 封装 DEK 与记录级加密
 * 遵循技术实施规范第 4.1 节
 */

import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorCodes, VpsMonitorError } from '../types/index.ts';

const APP_ID = 'vps-monitor';
const CURRENT_VAULT_VERSION = 1;

export interface VaultMetadata {
  version: number;
  salt: string; // base64, 32 bytes
  wrappedDek: {
    nonce: string; // base64, 12 bytes
    tag: string;   // base64, 16 bytes
    ciphertext: string; // base64
  };
  scryptParams: {
    N: number;
    r: number;
    p: number;
    keyLen: number;
  };
}

export interface EncryptedRecord {
  id: string; // credentialRef
  kind: 'password' | 'privateKey';
  algorithm: 'AES-256-GCM';
  nonce: string;
  tag: string;
  ciphertext: string;
  aad: string;
  createdAt: string;
}

export interface CredentialSecret {
  secret: string; // 明文密码或 PEM 私钥
  passphrase?: string;
}

export class CredentialVault {
  private readonly storageDir: string | null;
  private metadata: VaultMetadata | null = null;
  private activeDek: Buffer | null = null;
  private readonly records = new Map<string, EncryptedRecord>();

  constructor(storageDir: string | null = null) {
    this.storageDir = storageDir;
    if (this.storageDir) {
      this.ensureSecureDirectory(this.storageDir);
      this.loadFromDisk();
    }
  }

  public isInitialized(): boolean {
    return this.metadata !== null;
  }

  public isUnlocked(): boolean {
    return this.activeDek !== null;
  }

  /**
   * 初始化凭据库：生成随机 DEK，由主口令派生的 KEK 封装
   */
  public initialize(masterPassword: string): void {
    if (this.metadata !== null) {
      throw new VpsMonitorError(
        ErrorCodes.INVALID_INPUT,
        'Vault is already initialized'
      );
    }
    if (typeof masterPassword !== 'string' || masterPassword.length < 8) {
      throw new VpsMonitorError(
        ErrorCodes.INVALID_INPUT,
        'Master password must be at least 8 characters'
      );
    }

    const salt = randomBytes(32);
    const scryptParams = { N: 16384, r: 8, p: 1, keyLen: 32 };
    const kek = scryptSync(masterPassword, salt, 32, scryptParams);

    // 生成随机 DEK (32 bytes)
    const dek = randomBytes(32);
    const nonce = randomBytes(12);

    const cipher = createCipheriv('aes-256-gcm', kek, nonce);
    cipher.setAAD(Buffer.from(`${APP_ID}:vault-dek:v${CURRENT_VAULT_VERSION}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();

    this.metadata = {
      version: CURRENT_VAULT_VERSION,
      salt: salt.toString('base64'),
      wrappedDek: {
        nonce: nonce.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64')
      },
      scryptParams
    };

    if (this.activeDek) {
      this.activeDek.fill(0);
    }
    this.activeDek = dek;
    kek.fill(0); // 清理 KEK

    this.saveToDisk();
  }

  /**
   * 使用主口令解锁 DEK
   */
  public unlock(masterPassword: string): void {
    if (!this.metadata) {
      throw new VpsMonitorError(ErrorCodes.CREDENTIAL_LOCKED, 'Vault is not initialized');
    }
    if (typeof masterPassword !== 'string' || masterPassword.length === 0) {
      throw new VpsMonitorError(ErrorCodes.AUTH_FAILED, 'Invalid master password');
    }

    const salt = Buffer.from(this.metadata.salt, 'base64');
    const { N, r, p, keyLen } = this.metadata.scryptParams;
    const kek = scryptSync(masterPassword, salt, keyLen, { N, r, p });

    const nonce = Buffer.from(this.metadata.wrappedDek.nonce, 'base64');
    const tag = Buffer.from(this.metadata.wrappedDek.tag, 'base64');
    const ciphertext = Buffer.from(this.metadata.wrappedDek.ciphertext, 'base64');

    try {
      const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
      decipher.setAAD(Buffer.from(`${APP_ID}:vault-dek:v${this.metadata.version}`, 'utf8'));
      decipher.setAuthTag(tag);
      const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (this.activeDek) {
        this.activeDek.fill(0);
      }
      this.activeDek = dek;
    } catch {
      throw new VpsMonitorError(ErrorCodes.AUTH_FAILED, 'Invalid master password');
    } finally {
      kek.fill(0);
    }
  }

  /**
   * 锁定凭据库：覆写并清理内存中的 DEK
   */
  public lock(): void {
    if (this.activeDek) {
      this.activeDek.fill(0);
      this.activeDek = null;
    }
  }

  /**
   * 加密保存凭据
   */
  public storeCredential(
    id: string,
    kind: 'password' | 'privateKey',
    payload: CredentialSecret
  ): void {
    if (!this.isUnlocked() || !this.activeDek) {
      throw new VpsMonitorError(ErrorCodes.CREDENTIAL_LOCKED, 'Vault is locked');
    }

    const nonce = randomBytes(12);
    const aad = `${APP_ID}:${id}:${kind}:v1`;
    const cipher = createCipheriv('aes-256-gcm', this.activeDek, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));

    const plaintext = JSON.stringify(payload);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const record: EncryptedRecord = {
      id,
      kind,
      algorithm: 'AES-256-GCM',
      nonce: nonce.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      aad,
      createdAt: new Date().toISOString()
    };

    this.records.set(id, record);
    this.saveToDisk();
  }

  /**
   * 解密获取凭据，使用后调用方应尽可能短时间持有
   */
  public getCredential(id: string): CredentialSecret {
    if (!this.isUnlocked() || !this.activeDek) {
      throw new VpsMonitorError(ErrorCodes.CREDENTIAL_LOCKED, 'Vault is locked');
    }

    const record = this.records.get(id);
    if (!record) {
      throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, `Credential not found: ${id}`);
    }

    const nonce = Buffer.from(record.nonce, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    const ciphertext = Buffer.from(record.ciphertext, 'base64');

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.activeDek, nonce);
      decipher.setAAD(Buffer.from(record.aad, 'utf8'));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      return JSON.parse(plaintext) as CredentialSecret;
    } catch {
      throw new VpsMonitorError(ErrorCodes.STORAGE_ERROR, 'Failed to decrypt credential record');
    }
  }

  public hasCredential(id: string): boolean {
    return this.records.has(id);
  }

  public deleteCredential(id: string): boolean {
    const deleted = this.records.delete(id);
    if (deleted) {
      this.saveToDisk();
    }
    return deleted;
  }

  private ensureSecureDirectory(dir: string): void {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.chmodSync(dir, 0o700);
    } catch {
      throw new VpsMonitorError(
        ErrorCodes.STORAGE_ERROR,
        'Unable to enforce secure vault directory permissions'
      );
    }
  }

  private saveToDisk(): void {
    if (!this.storageDir || !this.metadata) return;

    const data = {
      metadata: this.metadata,
      records: Array.from(this.records.values())
    };

    const targetFile = path.join(this.storageDir, 'vault.enc.json');
    const tempFile = `${targetFile}.tmp.${process.pid}.${Date.now()}`;
    const fd = fs.openSync(tempFile, 'w', 0o600);
    try {
      // Hana 的 Node Permission Model 禁用 fsync API；保留临时文件 + rename 的原子替换。
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, targetFile);
    fs.chmodSync(targetFile, 0o600);
  }

  private loadFromDisk(): void {
    if (!this.storageDir) return;
    const targetFile = path.join(this.storageDir, 'vault.enc.json');
    if (!fs.existsSync(targetFile)) return;

    try {
      fs.chmodSync(targetFile, 0o600);
      const raw = fs.readFileSync(targetFile, 'utf8');
      const data = JSON.parse(raw);
      if (data.metadata) {
        this.metadata = data.metadata;
      }
      if (Array.isArray(data.records)) {
        for (const r of data.records) {
          this.records.set(r.id, r);
        }
      }
    } catch (e) {
      throw new VpsMonitorError(ErrorCodes.STORAGE_ERROR, 'Corrupted vault storage on disk');
    }
  }
}

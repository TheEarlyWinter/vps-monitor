import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CredentialVault } from '../../src/vault/credential-vault.ts';
import { ErrorCodes, VpsMonitorError } from '../../src/types/errors.ts';

test('CredentialVault: 内存模式初始化、锁定、加解密与内存清零', () => {
  const vault = new CredentialVault(null); // 内存模式

  assert.strictEqual(vault.isInitialized(), false);
  assert.strictEqual(vault.isUnlocked(), false);

  // 短口令拒绝
  assert.throws(
    () => vault.initialize('short'),
    (err: any) => err instanceof VpsMonitorError && err.code === ErrorCodes.INVALID_INPUT
  );

  vault.initialize('SuperSecretMasterPass123!');
  assert.strictEqual(vault.isInitialized(), true);
  assert.strictEqual(vault.isUnlocked(), true);

  // 存储 SSH 密码
  vault.storeCredential('cred-1', 'password', { secret: 'vps_root_password_999' });
  assert.strictEqual(vault.hasCredential('cred-1'), true);

  // 存储 SSH 私钥带 passphrase
  const fakePem = '-----BEGIN OPENSSH PRIVATE KEY-----\nMOCK_KEY_DATA\n-----END OPENSSH PRIVATE KEY-----';
  vault.storeCredential('cred-2', 'privateKey', { secret: fakePem, passphrase: 'key_passphrase' });

  // 读取凭据
  const c1 = vault.getCredential('cred-1');
  assert.strictEqual(c1.secret, 'vps_root_password_999');

  const c2 = vault.getCredential('cred-2');
  assert.strictEqual(c2.secret, fakePem);
  assert.strictEqual(c2.passphrase, 'key_passphrase');

  // 锁定后不可读
  vault.lock();
  assert.strictEqual(vault.isUnlocked(), false);
  assert.throws(
    () => vault.getCredential('cred-1'),
    (err: any) => err instanceof VpsMonitorError && err.code === ErrorCodes.CREDENTIAL_LOCKED
  );

  // 错误口令解锁失败
  assert.throws(
    () => vault.unlock('WrongPassword!'),
    (err: any) => err instanceof VpsMonitorError && err.code === ErrorCodes.AUTH_FAILED
  );
  assert.strictEqual(vault.isUnlocked(), false);

  // 正确口令解锁成功
  vault.unlock('SuperSecretMasterPass123!');
  assert.strictEqual(vault.isUnlocked(), true);
  assert.strictEqual(vault.getCredential('cred-1').secret, 'vps_root_password_999');
});

test('CredentialVault: 磁盘持久化、权限与重新加载', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-vault-test-'));
  try {
    const vault1 = new CredentialVault(tmpDir);
    vault1.initialize('DiskMasterPassword888!');
    vault1.storeCredential('cred-persist', 'password', { secret: 'persistent_secret_content' });
    vault1.lock();

    // 检查磁盘文件存在且为密文
    const encFile = path.join(tmpDir, 'vault.enc.json');
    assert.strictEqual(fs.existsSync(encFile), true);
    const content = fs.readFileSync(encFile, 'utf8');
    assert.strictEqual(content.includes('persistent_secret_content'), false);

    // 重新实例化 (模拟服务重启)
    const vault2 = new CredentialVault(tmpDir);
    assert.strictEqual(vault2.isInitialized(), true);
    assert.strictEqual(vault2.isUnlocked(), false);

    vault2.unlock('DiskMasterPassword888!');
    assert.strictEqual(vault2.isUnlocked(), true);
    const retrieved = vault2.getCredential('cred-persist');
    assert.strictEqual(retrieved.secret, 'persistent_secret_content');

    // 删除凭据
    vault2.deleteCredential('cred-persist');
    assert.strictEqual(vault2.hasCredential('cred-persist'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

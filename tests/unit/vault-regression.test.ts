import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialVault } from '../../src/vault/credential-vault.ts';
import { ErrorCodes, VpsMonitorError } from '../../src/types/errors.ts';

test('CredentialVault: 重复初始化必须被拒绝，不能破坏既有密文', () => {
  const vault = new CredentialVault(null);
  vault.initialize('InitialMasterPassword!');
  vault.storeCredential('cred-1', 'password', { secret: 'secret-value' });

  assert.throws(
    () => vault.initialize('SecondMasterPassword!'),
    (err: any) => err instanceof VpsMonitorError && err.code === ErrorCodes.INVALID_INPUT
  );
  assert.strictEqual(vault.getCredential('cred-1').secret, 'secret-value');
});

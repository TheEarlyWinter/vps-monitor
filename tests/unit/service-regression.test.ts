import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CredentialVault } from '../../src/vault/credential-vault.ts';
import { MonitorService } from '../../src/server/monitor-service.ts';

test('MonitorService: 删除服务器同时删除 credentialRef 对应的密文', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-service-regression-'));
  try {
    const vault = new CredentialVault(null);
    vault.initialize('ServiceRegressionPass!');
    vault.storeCredential('cred-srv-1', 'password', { secret: 'not-printed' });
    const service = new MonitorService(storageDir, vault);
    service.repo.save({
      id: 'srv-1',
      revision: 1,
      name: 'test',
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      authKind: 'password',
      credentialRef: 'cred-srv-1',
      hostKey: null,
      proxyRef: null,
      networkSelection: 'auto',
      interfaceNames: [],
      quotaBytes: null,
      quotaDirection: 'sum',
      resetDay: 1,
      billingTimeZone: 'UTC',
      enabled: false,
      sampleIntervalMs: 5000
    });

    await service.deleteServer('srv-1');
    assert.strictEqual(vault.hasCredential('cred-srv-1'), false);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

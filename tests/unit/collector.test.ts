import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectorEngine } from '../../src/collector/collector-engine.ts';
import { MockSshTransport } from '../../src/collector/mock-transport.ts';
import { CredentialVault } from '../../src/vault/credential-vault.ts';
import { TrafficLedger } from '../../src/ledger/traffic-ledger.ts';
import { REAL_LINUX_VMON1_OUTPUT } from '../fixtures/sample-vmon1.ts';
import type { ServerConfig, HostKeyPin } from '../../src/types/index.ts';

const baseConfig: ServerConfig = {
  id: 'srv-cloud-1',
  revision: 1,
  name: '云悠洛杉矶',
  host: '198.51.100.1',
  port: 22,
  username: 'debian',
  authKind: 'password',
  credentialRef: 'cred-cloud-1',
  hostKey: null, // 未确认
  proxyRef: null,
  networkSelection: 'auto',
  interfaceNames: [],
  quotaBytes: '1000000000000', // 1 TB
  quotaDirection: 'sum',
  resetDay: 1,
  billingTimeZone: 'America/Los_Angeles',
  enabled: true,
  sampleIntervalMs: 5000
};

test('CollectorEngine: 凭据锁定门禁', async () => {
  const vault = new CredentialVault(null); // 未解锁
  const ledger = new TrafficLedger(baseConfig.id);
  const transport = new MockSshTransport();
  const engine = new CollectorEngine(baseConfig, vault, ledger, transport);

  const res = await engine.stepSample();
  assert.strictEqual(res, null);
  assert.strictEqual(engine.getConnectionState(), 'credential_locked');
  assert.strictEqual(transport.isConnected(), false);
});

test('CollectorEngine: 首次连接指纹确认 (TOFU) 与连续两轮有效采样', async () => {
  const vault = new CredentialVault(null);
  vault.initialize('VaultPass1234!');
  vault.storeCredential('cred-cloud-1', 'password', { secret: 'vps_secret_pass' });

  const ledger = new TrafficLedger(baseConfig.id);
  let callCount = 0;
  const transport = new MockSshTransport({
    execOutput: () => {
      callCount++;
      if (callCount === 1) {
        return REAL_LINUX_VMON1_OUTPUT;
      }
      // 第二次采样：推进 uptime 5 秒，CPU total 增加，netdev 增加
      return REAL_LINUX_VMON1_OUTPUT
        .replace('108340.61 1599295.52', '108345.61 1599295.52')
        .replace('108340.68 1599296.35', '108345.68 1599296.35')
        .replace(
          'cpu  7563746 11573 4008968 159929570 49056 0 59368 0 0 0',
          'cpu  7565746 11573 4009968 159930570 49056 0 59368 0 0 0'
        )
        .replace(
          'enp2s0: 5278916018 5707674    0   14    0     0          0      1852 2720256536 3987389    0    0    0     0       0          0',
          'enp2s0: 5279416018 5708674    0   14    0     0          0      1852 2720556536 3988389    0    0    0     0       0          0'
        );
    }
  });

  let capturedHostKey: HostKeyPin | null = null;
  const engine = new CollectorEngine(baseConfig, vault, ledger, transport, {
    onHostKeyRequired: (_, hk) => {
      capturedHostKey = hk;
    }
  });

  // 1. 初次采样：因为 hostKey 为 null，应阻断并进入 host_key_required
  const res1 = await engine.stepSample();
  assert.strictEqual(res1, null);
  assert.strictEqual(engine.getConnectionState(), 'host_key_required');
  assert.ok(capturedHostKey);
  assert.strictEqual((capturedHostKey as HostKeyPin).algorithm, 'ssh-ed25519');

  // 2. 用户确认指纹
  await engine.confirmHostKey(capturedHostKey);
  assert.strictEqual(engine.getConnectionState(), 'online');

  // 第一轮采样结果：warming_up
  const snap1 = engine.getLatestSnapshot();
  assert.ok(snap1);
  assert.strictEqual(snap1.connectionState, 'online');
  assert.strictEqual(snap1.collectionHealth, 'warming_up');
  assert.strictEqual(snap1.cpu.busyPercent.value, null);

  // 3. 第二轮采样：进入 collecting
  await engine.stepSample();
  const snap2 = engine.getLatestSnapshot();
  assert.ok(snap2);
  assert.strictEqual(snap2.collectionHealth, 'collecting');
  assert.ok(snap2.cpu.busyPercent.value !== null);
  assert.strictEqual(snap2.memory.usedPercent.value, 83.64);
  assert.strictEqual(snap2.trafficPeriod?.observedTotalBytes, '800000'); // 第二采记录第一笔有效差分增量 (500000+300000)
});

test('CollectorEngine: 主机公钥变化拦截 (防中间人攻击)', async () => {
  const vault = new CredentialVault(null);
  vault.initialize('VaultPass1234!');
  vault.storeCredential('cred-cloud-1', 'password', { secret: 'vps_secret_pass' });

  const ledger = new TrafficLedger(baseConfig.id);
  // 模拟之前保存了一个旧指纹
  const pinnedConfig: ServerConfig = {
    ...baseConfig,
    hostKey: {
      algorithm: 'ssh-ed25519',
      publicKeyBlob: 'OLD_BLOB',
      fingerprintSha256: 'SHA256:OLD_FINGERPRINT',
      confirmedAt: new Date().toISOString()
    }
  };

  const transport = new MockSshTransport({
    mockHostKey: {
      algorithm: 'ssh-ed25519',
      publicKeyBlob: 'NEW_BLOB',
      fingerprintSha256: 'SHA256:NEW_ATTACKER_FINGERPRINT',
      confirmedAt: new Date().toISOString()
    }
  });

  const engine = new CollectorEngine(pinnedConfig, vault, ledger, transport);
  const res = await engine.stepSample();

  assert.strictEqual(res, null);
  assert.strictEqual(engine.getConnectionState(), 'host_key_changed');
  assert.strictEqual(transport.isConnected(), false);
});

test('CollectorEngine: 采样超时进入 retry_wait 并标记快照 stale', async () => {
  const vault = new CredentialVault(null);
  vault.initialize('VaultPass1234!');
  vault.storeCredential('cred-cloud-1', 'password', { secret: 'vps_secret_pass' });

  const ledger = new TrafficLedger(baseConfig.id);
  const validHostKey: HostKeyPin = {
    algorithm: 'ssh-ed25519',
    publicKeyBlob: 'QUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU9K...',
    fingerprintSha256: 'SHA256:4b9a39f426fdf1e7db9a39f426fdf1e7d',
    confirmedAt: new Date().toISOString()
  };

  const transport = new MockSshTransport({
    mockHostKey: validHostKey,
    execOutput: REAL_LINUX_VMON1_OUTPUT
  });

  const engine = new CollectorEngine(
    { ...baseConfig, hostKey: validHostKey },
    vault,
    ledger,
    transport
  );

  // 正常采一轮
  await engine.stepSample();
  assert.strictEqual(engine.getConnectionState(), 'online');

  // 注入超时错误
  transport.behaviors.execDelayMs = 10000; // 超过 8000ms 超时限制
  await engine.stepSample();

  assert.strictEqual(engine.getConnectionState(), 'retry_wait');
  const snap = engine.getLatestSnapshot();
  assert.ok(snap);
  assert.strictEqual(snap.collectionHealth, 'stale');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerApiRoutes } from '../../src/server/api-routes.ts';
import { MonitorService } from '../../src/server/monitor-service.ts';
import { CredentialVault } from '../../src/vault/credential-vault.ts';
import { MockSshTransport } from '../../src/collector/mock-transport.ts';
import { REAL_LINUX_VMON1_OUTPUT } from '../fixtures/sample-vmon1.ts';
import type { HostKeyPin } from '../../src/types/index.ts';

class MockHonoApp {
  private readonly routes: Array<{ method: string; path: string; handler: Function }> = [];

  public get(path: string, handler: Function) {
    this.routes.push({ method: 'GET', path, handler });
  }

  public post(path: string, handler: Function) {
    this.routes.push({ method: 'POST', path, handler });
  }

  public delete(path: string, handler: Function) {
    this.routes.push({ method: 'DELETE', path, handler });
  }

  public async dispatch(method: string, url: string, body?: any): Promise<{ status: number; body: any }> {
    for (const r of this.routes) {
      if (r.method !== method) continue;

      // 简单参数匹配，例如 /api/servers/:id
      const routeParts = r.path.split('/');
      const urlParts = url.split('/');
      if (routeParts.length !== urlParts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < routeParts.length; i++) {
        if (routeParts[i].startsWith(':')) {
          params[routeParts[i].slice(1)] = urlParts[i];
        } else if (routeParts[i] !== urlParts[i]) {
          matched = false;
          break;
        }
      }

      if (matched) {
        let responseStatus = 200;
        let responseData: any = null;

        const ctx = {
          req: {
            param: (k: string) => params[k],
            json: async () => body
          },
          json: (data: any, status = 200) => {
            responseStatus = status;
            responseData = data;
            return { status, data };
          }
        };

        await r.handler(ctx);
        return { status: responseStatus, body: responseData };
      }
    }

    throw new Error(`Route not found: ${method} ${url}`);
  }
}

test('API Routes: 全链路服务器添加、指纹确认、采样与凭据安全测试', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-api-test-'));

  try {
    const vault = new CredentialVault(null); // 内存模式测试
    const validHostKey: HostKeyPin = {
      algorithm: 'ssh-ed25519',
      publicKeyBlob: 'QUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU9K...',
      fingerprintSha256: 'SHA256:4b9a39f426fdf1e7db9a39f426fdf1e7d',
      confirmedAt: new Date().toISOString()
    };

    let callCount = 0;
    const service = new MonitorService(tmpDir, vault, () => {
      return new MockSshTransport({
        mockHostKey: validHostKey,
        execOutput: () => {
          callCount++;
          return REAL_LINUX_VMON1_OUTPUT
            .replace('108340.61', (108340.61 + callCount * 5).toFixed(2))
            .replace('108340.68', (108340.68 + callCount * 5).toFixed(2))
            .replace('cpu  7563746', `cpu  ${7563746 + callCount * 1000}`);
        }
      });
    });

    const app = new MockHonoApp();
    registerApiRoutes(app, service);

    // 1. 检查凭据库初始状态
    const vStatus1 = await app.dispatch('GET', '/api/vault/status');
    assert.strictEqual(vStatus1.body.data.isInitialized, false);
    assert.strictEqual(vStatus1.body.data.isUnlocked, false);

    // 2. 初始化凭据库
    const vInit = await app.dispatch('POST', '/api/vault/initialize', {
      masterPassword: 'MasterPassword123!'
    });
    assert.strictEqual(vInit.body.ok, true);

    const vStatus2 = await app.dispatch('GET', '/api/vault/status');
    assert.strictEqual(vStatus2.body.data.isUnlocked, true);

    // 3. 创建服务器（带密码）
    const serverPayload = {
      id: 'srv-test-cloud',
      name: '云悠洛杉矶测试机',
      host: '198.51.100.10',
      port: 22,
      username: 'debian',
      authKind: 'password',
      secret: 'super_secret_ssh_password',
      quotaBytes: '1000000000000',
      resetDay: 15,
      enabled: true
    };

    const createRes = await app.dispatch('POST', '/api/servers', serverPayload);
    assert.strictEqual(createRes.body.ok, true);
    // 确保返回的公共 DTO 中无任何密码字段
    assert.strictEqual(createRes.body.data.secret, undefined);
    assert.strictEqual(createRes.body.data.hasCredential, true);
    assert.strictEqual(createRes.body.data.hostKeyConfirmed, false);

    // 4. 初次触发采样：触发 TOFU 指纹阻断
    await service.triggerSample('srv-test-cloud');

    const listRes = await app.dispatch('GET', '/api/servers');
    assert.strictEqual(listRes.body.ok, true);
    assert.strictEqual(listRes.body.data.servers.length, 1);

    // 检查是否有待确认的 hostKey
    const pendingHk = listRes.body.data.pendingHostKeys['srv-test-cloud'];
    assert.ok(pendingHk);
    assert.strictEqual(pendingHk.fingerprintSha256, validHostKey.fingerprintSha256);
    assert.strictEqual(listRes.body.data.snapshots['srv-test-cloud'], null);
    assert.strictEqual(listRes.body.data.errors['srv-test-cloud'].code, 'HOST_KEY_REQUIRED');

    // 5. 确认主机指纹
    const confirmRes = await app.dispatch('POST', '/api/servers/srv-test-cloud/confirm-host-key', {
      hostKey: pendingHk
    });
    assert.strictEqual(confirmRes.body.ok, true);

    // 6. 再次采样并验证快照
    const sampleRes = await app.dispatch('POST', '/api/servers/srv-test-cloud/sample');
    assert.strictEqual(sampleRes.body.ok, true);
    const snap = sampleRes.body.data;
    assert.ok(snap);
    assert.strictEqual(snap.connectionState, 'online');
    assert.strictEqual(snap.memory.usedPercent.value, 83.64);

    // 7. 删除服务器
    const delRes = await app.dispatch('DELETE', '/api/servers/srv-test-cloud');
    assert.strictEqual(delRes.body.ok, true);

    const listResAfter = await app.dispatch('GET', '/api/servers');
    assert.strictEqual(listResAfter.body.data.servers.length, 0);

    // 清理 service 定时器
    await service.stopAll();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

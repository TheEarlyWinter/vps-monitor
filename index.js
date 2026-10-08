import path from 'node:path';
import fs from 'node:fs';
import { defineApp } from '@hana/app-sdk/server';
import { CredentialVault } from './src/vault/credential-vault.ts';
import { MonitorService } from './src/server/monitor-service.ts';
import { registerApiRoutes } from './src/server/api-routes.ts';
import { HanaSshTransport } from './src/collector/runtime-ssh-transport.ts';

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir || path.resolve('./.data');
  const vaultDir = path.join(dataDir, 'vault');
  const monitorDir = path.join(dataDir, 'monitor');

  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(monitorDir, { recursive: true });

  const vault = new CredentialVault(vaultDir);
  const transportFactory = sdk.runtime && typeof sdk.runtime.start === 'function'
    ? (config) => new HanaSshTransport(sdk.runtime, dataDir)
    : undefined;
  const monitorService = new MonitorService(monitorDir, vault, transportFactory);

  await monitorService.initialize();

  // 注册 HTTP API 路由
  if (sdk.routes && typeof sdk.routes.register === 'function') {
    await sdk.routes.register((app) => {
      registerApiRoutes(app, monitorService);
    });
  }

  // SDK v2 没有 onDeactivate 属性；使用进程退出信号确保 socket、定时器与 DEK 清理。
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await monitorService.stopAll();
    vault.lock();
  };
  process.once('SIGTERM', () => { void cleanup(); });
  process.once('SIGINT', () => { void cleanup(); });
  process.once('beforeExit', () => { void cleanup(); });
});

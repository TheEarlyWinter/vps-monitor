/**
 * Hono API 路由定义
 * 遵循技术实施规范第 9 节
 */

import {
  ErrorCodes,
  VpsMonitorError,
  type ServerConfig,
  type HostKeyPin,
  type AuthKind,
  type NetworkSelection,
  type QuotaDirection
} from '../types/index.ts';
import type { MonitorService } from './monitor-service.ts';
import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_INTERFACE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function registerApiRoutes(app: any, service: MonitorService): void {
  app.get('/api/vault/status', (c: any) => {
    return c.json({
      ok: true,
      data: {
        isInitialized: service.vault.isInitialized(),
        isUnlocked: service.vault.isUnlocked()
      }
    });
  });

  app.post('/api/vault/initialize', async (c: any) => {
    try {
      const body = await c.req.json();
      const masterPassword = body?.masterPassword;
      requirePassword(masterPassword);
      await service.initializeVault(masterPassword);
      return c.json({ ok: true, data: { isUnlocked: true } });
    } catch (e: any) {
      return formatError(c, e);
    }
  });

  app.post('/api/vault/unlock', async (c: any) => {
    try {
      const body = await c.req.json();
      const masterPassword = body?.masterPassword;
      requirePassword(masterPassword);
      await service.unlockVault(masterPassword);
      return c.json({ ok: true, data: { isUnlocked: true } });
    } catch (e: any) {
      return formatError(c, e);
    }
  });

  app.post('/api/vault/lock', async (c: any) => {
    await service.lockVault();
    return c.json({ ok: true, data: { isUnlocked: false } });
  });

  app.get('/api/servers', (c: any) => {
    const servers = service.listPublicServers();
    const snapshots: Record<string, any> = {};
    const pendingHostKeys: Record<string, any> = {};
    const errors: Record<string, any> = {};

    for (const s of servers) {
      snapshots[s.id] = service.getSnapshot(s.id);
      pendingHostKeys[s.id] = service.getPendingHostKey(s.id);
      errors[s.id] = service.getLastError(s.id);
    }

    return c.json({
      ok: true,
      data: { servers, snapshots, pendingHostKeys, errors }
    });
  });

  app.post('/api/servers', async (c: any) => {
    try {
      const body = await c.req.json();
      const id = body?.id || randomUUID();
      validateId(id);
      const existing = service.getServer(id);
      const credentialRef = existing?.credentialRef ?? `cred-${id}`;
      const authKind = (body?.authKind ?? existing?.authKind ?? 'password') as AuthKind;
      validateAuthKind(authKind);

      const serverConfig: ServerConfig = {
        id,
        revision: existing?.revision ?? 1,
        name: stringOr(body?.name, existing?.name ?? '未命名小鸡'),
        host: stringOr(body?.host, existing?.host ?? ''),
        port: integerOr(body?.port, existing?.port ?? 22),
        username: stringOr(body?.username, existing?.username ?? 'root'),
        authKind,
        credentialRef,
        // 未提交 hostKey 时必须保留既有 pin。
        hostKey: body?.hostKey === undefined
          ? (existing?.hostKey ?? null)
          : validateHostKey(body.hostKey),
        proxyRef: body?.proxyRef ?? existing?.proxyRef ?? null,
        networkSelection: (body?.networkSelection ?? existing?.networkSelection ?? 'auto') as NetworkSelection,
        interfaceNames: body?.interfaceNames === undefined
          ? (existing?.interfaceNames ?? [])
          : validateInterfaces(body.interfaceNames),
        quotaBytes: body?.quotaBytes === undefined
          ? (existing?.quotaBytes ?? null)
          : validateQuota(body.quotaBytes),
        quotaDirection: (body?.quotaDirection ?? existing?.quotaDirection ?? 'sum') as QuotaDirection,
        resetDay: integerOr(body?.resetDay, existing?.resetDay ?? 1),
        billingTimeZone: stringOr(body?.billingTimeZone, existing?.billingTimeZone ?? 'America/Los_Angeles'),
        enabled: body?.enabled === undefined ? (existing?.enabled ?? true) : body.enabled === true,
        sampleIntervalMs: integerOr(body?.sampleIntervalMs, existing?.sampleIntervalMs ?? 5000)
      };
      validateServerConfig(serverConfig);

      const secretProvided = typeof body?.secret === 'string' && body.secret.length > 0;
      if (!existing && !secretProvided) {
        throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Credential secret is required');
      }
      if (secretProvided) {
        if (!service.vault.isUnlocked()) {
          throw new VpsMonitorError(
            ErrorCodes.CREDENTIAL_LOCKED,
            'Vault must be unlocked to save credentials'
          );
        }
        service.vault.storeCredential(credentialRef, authKind, {
          secret: body.secret,
          passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined
        });
      }

      const saved = await service.saveServer(
        serverConfig,
        existing ? body.expectedRevision : undefined
      );
      return c.json({ ok: true, data: saved });
    } catch (e: any) {
      return formatError(c, e);
    }
  });

  app.delete('/api/servers/:id', async (c: any) => {
    const id = c.req.param('id');
    validateId(id);
    const success = await service.deleteServer(id);
    return c.json({ ok: success });
  });

  app.post('/api/servers/:id/confirm-host-key', async (c: any) => {
    try {
      const id = c.req.param('id');
      validateId(id);
      const body = await c.req.json();
      const hostKey = validateHostKey(body?.hostKey);
      if (!hostKey) {
        throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Valid hostKey is required');
      }
      const snapshot = await service.confirmHostKey(id, hostKey);
      return c.json({ ok: true, data: { snapshot } });
    } catch (e: any) {
      return formatError(c, e);
    }
  });

  app.post('/api/servers/:id/sample', async (c: any) => {
    const id = c.req.param('id');
    validateId(id);
    const snap = await service.triggerSample(id);
    return c.json({ ok: true, data: snap });
  });

  app.get('/api/servers/:id/snapshot', (c: any) => {
    const id = c.req.param('id');
    validateId(id);
    const snap = service.getSnapshot(id);
    return c.json({ ok: true, data: snap });
  });

  app.get('/api/servers/:id/history', (c: any) => {
    const id = c.req.param('id');
    validateId(id);
    const rawLimit = typeof c.req.query === 'function' ? c.req.query('limit') : undefined;
    const limit = rawLimit === undefined ? 120 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1440) {
      throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid history limit');
    }
    return c.json({ ok: true, data: service.getHistory(id, limit) });
  });

  app.get('/api/snapshots/poll', (c: any) => {
    return c.json({ ok: true, data: service.getAllSnapshots() });
  });
}

function requirePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 8) {
    throw new VpsMonitorError(
      ErrorCodes.INVALID_INPUT,
      'Master password must be at least 8 characters'
    );
  }
}

function validateId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid server id');
  }
}

function stringOr(value: unknown, fallback: string): string {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || result.trim().length === 0 || result.length > 255) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid text field');
  }
  return result.trim();
}

function integerOr(value: unknown, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result)) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid integer field');
  }
  return result;
}

function validateAuthKind(value: unknown): asserts value is AuthKind {
  if (value !== 'password' && value !== 'privateKey') {
    throw new VpsMonitorError(ErrorCodes.UNSUPPORTED_AUTH, 'Unsupported authentication method');
  }
}

function validateInterfaces(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !SAFE_INTERFACE.test(item))) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid network interface list');
  }
  return [...new Set(value)];
}

function validateQuota(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Quota must be a positive decimal string');
  }
  return value;
}

function validateHostKey(value: unknown): HostKeyPin | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid host key');
  }
  const hostKey = value as Partial<HostKeyPin>;
  if (
    typeof hostKey.algorithm !== 'string' ||
    typeof hostKey.publicKeyBlob !== 'string' ||
    typeof hostKey.fingerprintSha256 !== 'string' ||
    typeof hostKey.confirmedAt !== 'string'
  ) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid host key');
  }
  return {
    algorithm: hostKey.algorithm,
    publicKeyBlob: hostKey.publicKeyBlob,
    fingerprintSha256: hostKey.fingerprintSha256,
    confirmedAt: hostKey.confirmedAt
  };
}

function validateServerConfig(config: ServerConfig): void {
  if (!config.host || /[\s\u0000]/.test(config.host)) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid host');
  }
  if (config.port < 1 || config.port > 65535) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid SSH port');
  }
  if (config.networkSelection !== 'auto' && config.networkSelection !== 'explicit') {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid network selection');
  }
  if (!['rx', 'tx', 'sum'].includes(config.quotaDirection)) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid quota direction');
  }
  if (!Number.isInteger(config.resetDay) || config.resetDay < 1 || config.resetDay > 31) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid reset day');
  }
  if (!Number.isInteger(config.sampleIntervalMs) || config.sampleIntervalMs < 1000) {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid sample interval');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.billingTimeZone });
  } catch {
    throw new VpsMonitorError(ErrorCodes.INVALID_INPUT, 'Invalid billing time zone');
  }
}

function formatError(c: any, error: any) {
  if (error instanceof VpsMonitorError) {
    return c.json({ ok: false, error: error.toDTO() }, 400);
  }
  return c.json({
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error'
    }
  }, 500);
}

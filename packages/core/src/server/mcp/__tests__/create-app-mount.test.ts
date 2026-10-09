import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_WRITER,
  CACHE,
  JOB_QUEUE,
  MCP_TOKEN_AUTHENTICATOR,
  MESSAGE_BROKER,
  PLATFORM_CONFIG,
  RATE_LIMITER,
  REALTIME_TRANSPORT,
  definePlatformConfig,
  type ClientMeta,
  type McpTokenAuthentication,
  type MessageBrokerAdapter,
  type PlatformConfigInput,
} from '@openora/core/contracts';
import {
  adminCaller,
  makeAuditWriter,
  makeCache,
  makeJobQueue,
  makeRateLimiter,
  makeRealtimeTransport,
  mock,
} from '../../../testing/mock.js';
import {
  ADMIN_GUARD,
  AUTH_SESSION,
  type AdminGuard,
  type SessionResolver,
} from '../../auth/index.js';
import { getCurrentClientMeta } from '../../kernel/request-context.js';
import { createApp } from '../../runtime/create-app.js';

const DUMMY_DATABASE_URL = 'postgres://test:test@127.0.0.1:1/mcp_mount_test';
const BACKOFFICE_HOST = 'backoffice.example.com';
const MCP_URL = `http://${BACKOFFICE_HOST}/mcp`;
const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
const MCP_HEADERS = {
  authorization: 'Bearer ora_mcp_mount_test_token',
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const PEER_ADDRESS = '203.0.113.7';
const SPOOFED_ADDRESS = '198.51.100.1';

const tokenId = randomUUID();
const adminId = randomUUID();

const fromPeer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

async function bootApp({
  mcp = { enabled: true, allowedHosts: [BACKOFFICE_HOST] },
  authenticator = true,
  audit = true,
}: {
  mcp?: NonNullable<PlatformConfigInput['agents']>['mcp'];
  authenticator?: boolean;
  audit?: boolean;
} = {}) {
  const seenClientMeta: ClientMeta[] = [];
  const resolveSession = vi.fn(async () => null);
  const authenticate = vi.fn(async (): Promise<McpTokenAuthentication> => {
    seenClientMeta.push(getCurrentClientMeta());
    return { ok: true, tokenId, adminId };
  });
  const auditWriter = makeAuditWriter();
  const rateLimiter = makeRateLimiter();
  const app = await createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL }, (container) => {
    container.register(MESSAGE_BROKER, () =>
      mock<MessageBrokerAdapter>({
        publish: vi.fn(),
        subscribe: vi.fn(() => () => undefined),
        close: vi.fn(async () => undefined),
      }),
    );
    container.register(JOB_QUEUE, () => makeJobQueue());
    container.register(CACHE, () => makeCache());
    container.register(RATE_LIMITER, () => rateLimiter);
    container.register(REALTIME_TRANSPORT, () => makeRealtimeTransport());
    container.register(PLATFORM_CONFIG, () => definePlatformConfig({ agents: { mcp } }));
    container.register(AUTH_SESSION, () => mock<SessionResolver>({ resolveSession }));
    container.register(ADMIN_GUARD, () =>
      mock<AdminGuard>({
        assertUser: vi.fn(async () => adminCaller({ userId: adminId })),
        filterGranted: vi.fn(async () => []),
      }),
    );
    if (authenticator) {
      container.register(MCP_TOKEN_AUTHENTICATOR, () => ({
        authenticate,
        recordCall: vi.fn(async () => undefined),
      }));
    }
    if (audit) {
      container.register(AUDIT_WRITER, () => auditWriter);
    }
  });
  return { app, resolveSession, authenticate, seenClientMeta, auditWriter, rateLimiter };
}

const savedRedisUrl = process.env['REDIS_URL'];

beforeEach(() => {
  delete process.env['REDIS_URL'];
});

afterEach(() => {
  if (savedRedisUrl !== undefined) {
    process.env['REDIS_URL'] = savedRedisUrl;
  }
});

describe('createApp refusing to boot the MCP transport', () => {
  it('names the missing token authenticator', async () => {
    await expect(bootApp({ authenticator: false })).rejects.toThrow(
      /agents\.mcp\.enabled is on.*\n.*MCP_TOKEN_AUTHENTICATOR: load the iam module/,
    );
  });

  it('names the missing audit writer', async () => {
    await expect(bootApp({ audit: false })).rejects.toThrow(/AUDIT_WRITER: load the audit module/);
  });
});

describe('createApp with the MCP transport on', () => {
  it('answers on the bound host without running the session middleware', async () => {
    const { app, resolveSession } = await bootApp();

    const response = await app.app.request(MCP_URL, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: PING,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(resolveSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the app CORS policy off a refused browser origin', async () => {
    const { app } = await bootApp();

    const response = await app.app.request(MCP_URL, {
      method: 'POST',
      headers: { ...MCP_HEADERS, origin: 'https://evil.example' },
      body: PING,
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    await app.close();
  });

  it('serves the request inside the request context, under the client address', async () => {
    const { app, seenClientMeta } = await bootApp();

    await app.app.request(
      MCP_URL,
      {
        method: 'POST',
        headers: { ...MCP_HEADERS, 'user-agent': 'mcp-client/1.0', 'x-real-ip': SPOOFED_ADDRESS },
        body: PING,
      },
      fromPeer(PEER_ADDRESS),
    );

    expect(seenClientMeta).toEqual([{ ip: PEER_ADDRESS, userAgent: 'mcp-client/1.0' }]);
    await app.close();
  });

  it('limits the client address the proxy boundary resolved, not the one a header claims', async () => {
    const { app, rateLimiter } = await bootApp();

    await app.app.request(
      MCP_URL,
      {
        method: 'POST',
        headers: { ...MCP_HEADERS, 'x-real-ip': SPOOFED_ADDRESS },
        body: PING,
      },
      fromPeer(PEER_ADDRESS),
    );

    expect(rateLimiter.consume).toHaveBeenCalledWith(`mcp-ip-min:${PEER_ADDRESS}`, {
      limit: 300,
      windowMs: 60_000,
      onUnavailable: 'deny',
    });
    expect(rateLimiter.consume).not.toHaveBeenCalledWith(
      `mcp-ip-min:${SPOOFED_ADDRESS}`,
      expect.anything(),
    );
    await app.close();
  });

  it('audits a refused tool name through the bound audit writer', async () => {
    const { app, auditWriter } = await bootApp();

    const response = await app.app.request(
      MCP_URL,
      {
        method: 'POST',
        headers: { ...MCP_HEADERS, 'user-agent': 'mcp-client/1.0' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'player_delete', arguments: {} },
        }),
      },
      fromPeer(PEER_ADDRESS),
    );

    expect(await response.json()).toMatchObject({
      id: 2,
      error: { code: -32602, message: expect.stringContaining('Unknown tool') },
    });
    expect(auditWriter.record).toHaveBeenCalledTimes(1);
    expect(auditWriter.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: adminId,
        action: 'mcp.tool.failed',
        resourceId: 'player_delete',
        ip: PEER_ADDRESS,
        userAgent: 'mcp-client/1.0',
        after: expect.objectContaining({ error: 'not_exposed', tokenId }),
      }),
    );
    await app.close();
  });

  it('falls through to the normal 404 on a host it is not bound to', async () => {
    const { app, authenticate, resolveSession } = await bootApp();

    const response = await app.app.request('http://player.example.com/mcp', {
      method: 'POST',
      headers: MCP_HEADERS,
      body: PING,
    });

    expect(response.status).toBe(404);
    expect(authenticate).not.toHaveBeenCalled();
    expect(resolveSession).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('refuses a body over 1 MiB with a no-store JSON-RPC 413, before authenticating', async () => {
    const { app, authenticate } = await bootApp();

    const response = await app.app.request(MCP_URL, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: 'x'.repeat(1_048_577),
    });

    expect(response.status).toBe(413);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    expect(authenticate).not.toHaveBeenCalled();
    await app.close();
  });
});

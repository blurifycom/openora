import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
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
  type MessageBrokerAdapter,
  type PlatformConfigInput,
} from '@openora/core/contracts';
import {
  makeAuditWriter,
  makeCache,
  makeJobQueue,
  makeRateLimiter,
  makeRealtimeTransport,
  mock,
} from '../../../testing/mock.js';
import { AUTH_SESSION, type SessionResolver } from '../../auth/index.js';
import { createApp } from '../../runtime/create-app.js';

const missingSdk = vi.hoisted(
  () => () =>
    Object.assign(
      new Error(
        "Cannot find package '@modelcontextprotocol/sdk' imported from /srv/app/node_modules/@openora/core/dist/server/mcp/http-transport.js",
      ),
      { code: 'ERR_MODULE_NOT_FOUND' },
    ),
);
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  throw missingSdk();
});
vi.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => {
  throw missingSdk();
});
vi.mock('@modelcontextprotocol/sdk/types.js', () => {
  throw missingSdk();
});
vi.mock('@modelcontextprotocol/sdk/validation/ajv', () => {
  throw missingSdk();
});

const MCP_SDK_PACKAGE = '@modelcontextprotocol/sdk';
const DUMMY_DATABASE_URL = 'postgres://test:test@127.0.0.1:1/mcp_sdk_missing_test';
const BACKOFFICE_HOST = 'backoffice.example.com';

const CorePackageSchema = z.object({
  peerDependencies: z.object({ [MCP_SDK_PACKAGE]: z.string() }),
  peerDependenciesMeta: z.object({ [MCP_SDK_PACKAGE]: z.object({ optional: z.literal(true) }) }),
});

function declaredSdkPeer() {
  const corePackage = CorePackageSchema.parse(
    JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')),
  );
  return corePackage.peerDependencies[MCP_SDK_PACKAGE];
}

function bootApp(mcp: NonNullable<PlatformConfigInput['agents']>['mcp']) {
  return createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL }, (container) => {
    container.register(MESSAGE_BROKER, () =>
      mock<MessageBrokerAdapter>({
        publish: vi.fn(),
        subscribe: vi.fn(() => () => undefined),
        close: vi.fn(async () => undefined),
      }),
    );
    container.register(JOB_QUEUE, () => makeJobQueue());
    container.register(CACHE, () => makeCache());
    container.register(RATE_LIMITER, () => makeRateLimiter());
    container.register(REALTIME_TRANSPORT, () => makeRealtimeTransport());
    container.register(PLATFORM_CONFIG, () => definePlatformConfig({ agents: { mcp } }));
    container.register(AUTH_SESSION, () =>
      mock<SessionResolver>({ resolveSession: vi.fn(async () => null) }),
    );
    container.register(MCP_TOKEN_AUTHENTICATOR, () => ({
      authenticate: vi.fn(async () => ({
        ok: true as const,
        tokenId: randomUUID(),
        adminId: randomUUID(),
      })),
      recordCall: vi.fn(async () => undefined),
    }));
    container.register(AUDIT_WRITER, () => makeAuditWriter());
  });
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

describe('createApp without the optional MCP SDK installed', () => {
  it('boots and serves with the transport off, never loading the SDK', async () => {
    const app = await bootApp({ allowedHosts: [BACKOFFICE_HOST] });

    const response = await app.app.request(`http://${BACKOFFICE_HOST}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

    expect(response.status).toBe(404);
    await app.close();
  });

  it('refuses to boot with the transport on, naming the optional peer and the version core declares', async () => {
    await expect(bootApp({ enabled: true, allowedHosts: [BACKOFFICE_HOST] })).rejects.toThrow(
      `${MCP_SDK_PACKAGE} is not installed. @openora/core declares it as an optional peer dependency: install ${MCP_SDK_PACKAGE}@${declaredSdkPeer()}, or turn agents.mcp.enabled off.`,
    );
  });
});

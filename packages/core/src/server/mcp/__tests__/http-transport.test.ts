import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ORPCError } from '@orpc/server';
import {
  McpToolError,
  McpTransportConfigSchema,
  type McpKernel,
  type McpTokenAuthentication,
  type RateLimitKey,
  type RateLimiterAdapter,
} from '@openora/core/contracts';
import { NO_CLIENT_META, adminCaller, makeRateLimiter, mock } from '../../../testing/mock.js';
import type { AdminGuard } from '../../auth/admin-guard.js';
import { createMcpHttpTransport, type McpHttpTransport } from '../http-transport.js';
import type { McpAuthorizer } from '../kernel.js';
import {
  PLAYER_EMAIL,
  summaryHandler,
  transportKernel,
  type SummaryHandler,
} from './fixtures/transport-kernel.js';

const log = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock('../../kernel/logger.js', () => ({ createLogger: () => log }));

const MCP_URL = 'http://localhost/mcp';
const BACKOFFICE = 'https://backoffice.example.com';
const TOKEN = `ora_mcp_${'Tk3n_'.repeat(8)}abc`;
const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };
const SECRET_FAILURE = 'connection to db failed: password=hunter2';

const tokenId = randomUUID();
const adminId = randomUUID();
const playerId = randomUUID();

type Requirement = { resource: string; action: string };

type Setup = {
  authentication?: McpTokenAuthentication;
  handler?: SummaryHandler;
  authorize?: McpAuthorizer;
  wrapKernel?: (kernel: McpKernel) => McpKernel;
  config?: Record<string, unknown>;
  assertUser?: () => Promise<unknown>;
  filterGranted?: <T extends Requirement>(requirements: readonly T[]) => Promise<T[]>;
  rateLimiter?: RateLimiterAdapter<RateLimitKey>;
  recordCall?: () => Promise<void>;
};

function setup({
  authentication = { ok: true, tokenId, adminId },
  handler = summaryHandler,
  authorize,
  wrapKernel = (kernel) => kernel,
  config = {},
  assertUser = async () => adminCaller({ userId: adminId }),
  filterGranted = async (requirements) => [...requirements],
  rateLimiter = makeRateLimiter(),
  recordCall = async () => undefined,
}: Setup = {}) {
  const { kernel, audit } = transportKernel({ handler, authorize });
  const authenticator = {
    authenticate: vi.fn(async (_bearer: string) => authentication),
    recordCall: vi.fn(recordCall),
  };
  const guard = {
    assertUser: vi.fn(assertUser),
    filterGranted: vi.fn(async (_userId: string, requirements: readonly Requirement[]) =>
      filterGranted(requirements),
    ),
  };
  const transport = createMcpHttpTransport({
    kernel: wrapKernel(kernel),
    authenticator,
    adminGuard: mock<Pick<AdminGuard, 'assertUser' | 'filterGranted'>>(guard),
    rateLimiter,
    config: McpTransportConfigSchema.parse({ enabled: true, ...config }),
  });
  return { transport, kernel, audit, authenticator, guard };
}

async function connect(
  transport: McpHttpTransport,
  headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` },
) {
  const client = new Client({ name: 'transport-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (url, init) => transport.handle(new Request(url, init), NO_CLIENT_META),
      requestInit: { headers },
    }),
  );
  return client;
}

function send(
  transport: McpHttpTransport,
  {
    method = 'POST',
    headers = {},
    body = JSON.stringify(PING),
  }: { method?: string; headers?: Record<string, string>; body?: string | null } = {},
) {
  return transport.handle(
    new Request(MCP_URL, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? null : body,
    }),
    NO_CLIENT_META,
  );
}

function textOf(result: CallToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') {
    throw new Error('expected a text block');
  }
  return JSON.parse(block.text);
}

async function callSummary(client: Client, args: Record<string, unknown> = { playerId }) {
  await client.listTools();
  return CallToolResultSchema.parse(
    await client.callTool({ name: 'player_summary', arguments: args }),
  );
}

const loggedOutput = () =>
  inspect(
    Object.values(log).map((method) => method.mock.calls),
    { depth: null },
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MCP HTTP transport through the SDK client', () => {
  it('initializes as openora at the kernel catalog version', async () => {
    const { transport, kernel } = setup();

    const client = await connect(transport);

    expect(client.getServerVersion()).toEqual({ name: 'openora', version: kernel.catalogVersion });
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    await client.close();
  });

  it('lists only read tools, under model names, with the output schema the client receives', async () => {
    const { transport } = setup();
    const client = await connect(transport);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['player_summary']);
    const [summary] = tools;
    expect(Object.keys(summary?.outputSchema?.properties ?? {})).toEqual([
      'playerId',
      'status',
      'balance',
      'note',
    ]);
    expect(summary?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    await client.close();
  });

  it('lists only the tools the admin is granted', async () => {
    const { transport, guard } = setup({ filterGranted: async () => [] });
    const client = await connect(transport);

    const { tools } = await client.listTools();

    expect(tools).toEqual([]);
    expect(guard.filterGranted).toHaveBeenCalledWith(adminId, [
      expect.objectContaining({ resource: 'player', action: 'view' }),
    ]);
    await client.close();
  });

  it('answers a call that passes the client output validation, without personal keys', async () => {
    const { transport, audit } = setup();
    const client = await connect(transport);

    const result = await callSummary(client);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ playerId, status: 'active', balance: '12.50' });
    expect(textOf(result)).toEqual(result.structuredContent);
    expect(JSON.stringify(result)).not.toContain(PLAYER_EMAIL);
    const correlationId = result._meta?.['openora/correlationId'];
    expect(correlationId).toEqual(expect.any(String));
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: adminId,
        action: 'mcp.tool.invoked',
        resourceId: 'player.summary',
        correlationId,
        after: expect.objectContaining({ actorKind: 'mcp_token', tokenId }),
      }),
    );
    await client.close();
  });

  it('lets the personal keys through when the operator includes them', async () => {
    const { transport } = setup({ config: { personalFields: 'include' } });
    const client = await connect(transport);

    const result = await callSummary(client);

    expect(result.structuredContent).toEqual({
      playerId,
      email: PLAYER_EMAIL,
      status: 'active',
      balance: '12.50',
    });
    await client.close();
  });

  it('records one call per tool call and none for the handshake or the listing', async () => {
    const { transport, authenticator } = setup();
    const client = await connect(transport);

    await callSummary(client);
    await client.callTool({ name: 'player_summary', arguments: { playerId } });

    expect(authenticator.recordCall).toHaveBeenCalledTimes(2);
    expect(authenticator.recordCall).toHaveBeenCalledWith(tokenId);
    await client.close();
  });

  it('answers the call even when recording it fails', async () => {
    const { transport } = setup({
      recordCall: async () => {
        throw new Error(SECRET_FAILURE);
      },
    });
    const client = await connect(transport);

    const result = await callSummary(client);

    expect(result.isError).toBeFalsy();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId }),
      'mcp token call was not recorded',
    );
    await client.close();
  });

  it('returns a declared kernel failure as an error result with its code alone', async () => {
    const { transport } = setup({
      handler: async () => {
        throw new McpToolError('player_not_found');
      },
    });
    const client = await connect(transport);

    const result = await callSummary(client);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toStrictEqual({ error: 'player_not_found' });
    await client.close();
  });

  it('returns invalid input with the issues the kernel reported', async () => {
    const { transport } = setup();
    const client = await connect(transport);

    const result = await callSummary(client, { playerId: 'not-a-uuid' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toStrictEqual({
      error: 'invalid_input',
      issues: [{ path: 'playerId', message: expect.any(String) }],
    });
    await client.close();
  });

  it('returns the kernel refusing the tool permission as forbidden', async () => {
    const { transport } = setup({ authorize: async () => 'denied' });
    const client = await connect(transport);

    const result = await callSummary(client);

    expect(textOf(result)).toStrictEqual({ error: 'forbidden' });
    await client.close();
  });

  it('turns a thrown kernel error into internal_error without its message', async () => {
    const { transport } = setup({
      wrapKernel: (kernel) => ({
        ...kernel,
        invokeTool: async () => {
          throw new Error(SECRET_FAILURE);
        },
      }),
    });
    const client = await connect(transport);

    const result = await callSummary(client);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toStrictEqual({ error: 'internal_error' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
    await client.close();
  });

  it('refuses a name that is not a served model name without calling the kernel', async () => {
    const { transport, audit } = setup();
    const client = await connect(transport);

    for (const name of ['player_flag', 'player.summary', 'nope']) {
      await expect(client.callTool({ name, arguments: { playerId } })).rejects.toThrow(
        /Unknown tool/,
      );
    }
    expect(audit.record).not.toHaveBeenCalled();
    await client.close();
  });

  it('hides why a listing failed', async () => {
    const { transport } = setup({
      filterGranted: async () => {
        throw new Error(SECRET_FAILURE);
      },
    });
    const client = await connect(transport);

    const listing = client.listTools();

    await expect(listing).rejects.toThrow(/Internal error/);
    await expect(listing).rejects.not.toThrow(/hunter2/);
    await client.close();
  });
});

describe('MCP HTTP transport refusals', () => {
  it('answers a ping without a handshake, no-store and without CORS headers', async () => {
    const { transport } = setup();

    const response = await send(transport);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('vary')).toBeNull();
  });

  it('refuses a missing bearer with a bare challenge, before authenticating', async () => {
    const { transport, authenticator } = setup();

    const response = await send(transport, { headers: { authorization: '' } });
    const rejected = connect(transport, {});

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    await expect(rejected).rejects.toMatchObject({ code: 401 });
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, reason: 'unknown' },
    { ok: false, reason: 'expired', tokenId, adminId },
    { ok: false, reason: 'revoked', tokenId, adminId },
  ] as const)('refuses a $reason token as invalid_token', async (authentication) => {
    const { transport, guard } = setup({ authentication });

    const response = await send(transport);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(guard.assertUser).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: authentication.reason }),
      'mcp token refused',
    );
  });

  it('refuses an admin without MCP access with a 403 that names no challenge', async () => {
    const { transport, guard } = setup({
      assertUser: async () => {
        throw new ORPCError('FORBIDDEN', { message: 'Missing permission: mcp-access:use' });
      },
    });

    const response = await send(transport);
    const rejected = connect(transport);

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(guard.assertUser).toHaveBeenCalledWith(adminId, 'mcp-access', 'use');
    await expect(rejected).rejects.toMatchObject({ code: 403 });
  });

  it('fails closed with a constant 500 when the grant check breaks', async () => {
    const { transport } = setup({
      assertUser: async () => {
        throw new Error(SECRET_FAILURE);
      },
    });

    const response = await send(transport);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
  });

  it('refuses a browser origin that is not allowed, before anything else', async () => {
    const { transport, authenticator } = setup({ config: { allowedOrigins: [BACKOFFICE] } });

    const post = await send(transport, { headers: { origin: 'https://evil.example' } });
    const preflight = await send(transport, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });

    expect(post.status).toBe(403);
    expect(preflight.status).toBe(403);
    expect(post.headers.get('access-control-allow-origin')).toBeNull();
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });

  it('refuses every browser origin when none is allowed', async () => {
    const { transport } = setup();

    const response = await send(transport, { headers: { origin: BACKOFFICE } });

    expect(response.status).toBe(403);
  });

  it('answers the preflight of an allowed origin and marks its responses for it', async () => {
    const { transport } = setup({ config: { allowedOrigins: [BACKOFFICE] } });

    const preflight = await send(transport, { method: 'OPTIONS', headers: { origin: BACKOFFICE } });
    const post = await send(transport, { headers: { origin: BACKOFFICE } });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(BACKOFFICE);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
    expect(post.status).toBe(200);
    expect(post.headers.get('access-control-allow-origin')).toBe(BACKOFFICE);
    expect(post.headers.get('vary')).toBe('Origin');
    expect(post.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it.each(['GET', 'DELETE', 'PUT', 'OPTIONS'])(
    'answers %s with 405 before looking at the bearer',
    async (method) => {
      const { transport, authenticator } = setup();

      const response = await send(transport, { method, headers: { authorization: '' } });

      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(authenticator.authenticate).not.toHaveBeenCalled();
    },
  );

  it('limits the token with a Retry-After, before checking the grant', async () => {
    const consume = vi.fn(async () => ({ allowed: false, retryAfterMs: 1500 }));
    const { transport, guard } = setup({
      rateLimiter: mock<RateLimiterAdapter<RateLimitKey>>({ consume }),
    });

    const response = await send(transport);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(consume).toHaveBeenCalledWith(`mcp-token-min:${tokenId}`, expect.anything());
    expect(guard.assertUser).not.toHaveBeenCalled();
  });

  it('refuses a JSON-RPC batch without running any of it', async () => {
    const { transport, audit } = setup();
    const call = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'player_summary', arguments: { playerId } },
    };

    const response = await send(transport, {
      body: JSON.stringify([
        { ...call, id: 1 },
        { ...call, id: 2 },
      ]),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32600 } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON', async () => {
    const { transport } = setup();

    const response = await send(transport, { body: '{"jsonrpc":' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  });
});

describe('MCP HTTP transport logging', () => {
  it('never logs the bearer token or the Authorization header', async () => {
    const refused = setup({ authentication: { ok: false, reason: 'revoked', tokenId, adminId } });
    const broken = setup({
      wrapKernel: (kernel) => ({
        ...kernel,
        invokeTool: async () => {
          throw new Error(SECRET_FAILURE);
        },
      }),
    });
    const failing = setup({
      assertUser: async () => {
        throw new Error(SECRET_FAILURE);
      },
    });

    await send(refused.transport);
    await send(failing.transport);
    const client = await connect(broken.transport);
    await callSummary(client);
    await client.close();

    expect(log.warn).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
    expect(loggedOutput()).not.toContain(TOKEN);
    expect(loggedOutput().toLowerCase()).not.toContain('authorization');
  });
});

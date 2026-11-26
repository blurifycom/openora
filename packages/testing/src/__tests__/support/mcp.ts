import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { loadExtensions } from '@openora/core/server';
import { bootE2e, closeE2e, newStaff, type E2e, type NamedAccount } from '../../index.js';

import { MCP_TEST_HOST } from './test-mcp-plugin.js';

export const MCP_PASSWORD = 'password1234';

const mcpPlugin = {
  id: 'testing-mcp',
  path: fileURLToPath(new URL('./test-mcp-plugin.ts', import.meta.url)),
};

export const bootMcpE2e = async () =>
  bootE2e({ plugins: [...(await loadExtensions()), mcpPlugin] });

export { closeE2e };

export const IssuedTokenSchema = z.object({
  id: z.string(),
  token: z.string(),
  tokenPrefix: z.string(),
  adminUserId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const JsonRpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

export const ToolsListSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      outputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }),
    }),
  ),
});

export const newMcpAdmin = (e2e: E2e, roleKey = 'admin'): Promise<NamedAccount> =>
  newStaff(e2e.app, 'mcp', roleKey);

export async function issueToken(
  admin: NamedAccount,
  extra: { label?: string; ttlDays?: number } = {},
) {
  const res = await admin.client.post('/iam/my-mcp-tokens', {
    label: extra.label ?? 'agent token',
    currentPassword: MCP_PASSWORD,
    ...(extra.ttlDays === undefined ? {} : { ttlDays: extra.ttlDays }),
  });
  const body: unknown = await res.json();
  if (res.status !== 200) {
    throw new Error(`token issue failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return IssuedTokenSchema.parse(body);
}

const freshIp = () => `10.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`;

export type McpCallOptions = {
  token?: string;
  ip?: string;
  method?: string;
  origin?: string;
  authorization?: string;
  body?: unknown;
  rawBody?: string;
};

export async function mcpCall(e2e: E2e, options: McpCallOptions = {}) {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-real-ip': options.ip ?? freshIp(),
  });
  const authorization =
    options.authorization ?? (options.token ? `Bearer ${options.token}` : undefined);
  if (authorization) {
    headers.set('authorization', authorization);
  }
  if (options.origin) {
    headers.set('origin', options.origin);
  }
  const method = options.method ?? 'POST';
  const body = options.rawBody ?? JSON.stringify(options.body ?? toolsList());
  const res = await e2e.app.app.request(`http://${MCP_TEST_HOST}/mcp`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
  const text = await res.text();
  const parsed: unknown = text === '' ? null : JSON.parse(text);
  return { res, status: res.status, body: parsed };
}

export const toolsList = () => ({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

export const toolsCall = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name, arguments: args },
});

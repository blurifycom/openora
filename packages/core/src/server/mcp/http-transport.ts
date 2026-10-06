import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type {
  ClientMeta,
  McpIamRequirement,
  McpKernel,
  McpTokenAuthentication,
  McpTokenAuthenticator,
  McpTransportConfig,
  RateLimitKey,
  RateLimiterAdapter,
  RunContext,
} from '@openora/core/contracts';
import type { AdminGuard } from '../auth/admin-guard.js';
import { createLogger } from '../kernel/logger.js';
import { authorizeWithAdminGuard } from './authorize.js';
import {
  accessDenied,
  batchRefused,
  bearerRequired,
  consumeTokenRateLimit,
  corsHeaders,
  internalError,
  invalidToken,
  methodNotAllowed,
  noStore,
  originRefused,
  originVerdict,
  parseBearer,
  parseError,
  preflight,
  rateLimited,
  servesHost,
  withHeaders,
} from './transport-gate.js';
import { exposedTools, toCallToolResult, type ExposedTool } from './transport-tools.js';

const logger = createLogger('mcp-transport');

const SERVER_NAME = 'openora';
const MCP_ACCESS: McpIamRequirement = { resource: 'mcp-access', action: 'use' };

export type McpHttpTransportDeps = {
  kernel: McpKernel;
  authenticator: McpTokenAuthenticator;
  adminGuard: Pick<AdminGuard, 'assertUser' | 'filterGranted'>;
  rateLimiter: RateLimiterAdapter<RateLimitKey>;
  config: McpTransportConfig;
};

export type McpHttpTransport = {
  servesHost(hostname: string): boolean;
  handle(request: Request, clientMeta: ClientMeta): Promise<Response>;
};

type TransportState = McpHttpTransportDeps & {
  tools: readonly ExposedTool[];
  toolsByName: ReadonlyMap<string, ExposedTool>;
  validator: AjvJsonSchemaValidator;
};

type Caller = Extract<McpTokenAuthentication, { ok: true }>;

type ToolCall = Caller & { correlationId: RunContext['correlationId'] };

/**
 * The MCP Streamable HTTP endpoint for admin tokens, stateless and answering in JSON. Each
 * request passes, in order: the Origin check, POST only, the bearer, the token, the token's
 * minute and day limits, and the admin's MCP grant; only then does the SDK see it. Only
 * read-class tools are served, and every call runs through the kernel under the token's admin.
 * Throws at construction when a tool's schemas cannot be published.
 */
export function createMcpHttpTransport(deps: McpHttpTransportDeps): McpHttpTransport {
  const tools = exposedTools(deps.kernel.listTools(), deps.config.personalFields);
  const state: TransportState = {
    ...deps,
    tools,
    toolsByName: new Map(tools.map((tool) => [tool.definition.name, tool])),
    validator: new AjvJsonSchemaValidator(),
  };
  return {
    servesHost: (hostname) => servesHost(hostname, deps.config.allowedHosts),
    handle: (request, clientMeta) => handle(state, request, clientMeta),
  };
}

async function handle(state: TransportState, request: Request, clientMeta: ClientMeta) {
  const origin = request.headers.get('origin');
  const verdict = originVerdict(origin, state.config.allowedOrigins);
  if (verdict === 'refused') {
    return originRefused();
  }
  const allowedOrigin = verdict === 'allowed' ? origin : null;
  if (allowedOrigin === null) {
    return serve(state, request, clientMeta);
  }
  if (request.method === 'OPTIONS') {
    return preflight(allowedOrigin);
  }
  return withHeaders(await serve(state, request, clientMeta), corsHeaders(allowedOrigin));
}

async function serve(state: TransportState, request: Request, clientMeta: ClientMeta) {
  // In stateless mode the SDK answers a GET with an SSE stream that never ends; its client
  // reads a 405 as "no stream" and carries on over POST.
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }
  const bearer = parseBearer(request.headers.get('authorization'));
  if (bearer === null) {
    return bearerRequired();
  }
  try {
    return await serveBearer(state, { request, bearer, clientMeta });
  } catch (err) {
    logger.error({ err }, 'mcp request failed');
    return internalError();
  }
}

async function serveBearer(
  state: TransportState,
  { request, bearer, clientMeta }: { request: Request; bearer: string; clientMeta: ClientMeta },
) {
  const authentication = await state.authenticator.authenticate(bearer);
  if (!authentication.ok) {
    logger.warn(
      authentication.reason === 'unknown'
        ? { reason: authentication.reason, ip: clientMeta.ip }
        : { reason: authentication.reason, tokenId: authentication.tokenId, ip: clientMeta.ip },
      'mcp token refused',
    );
    return invalidToken();
  }
  const limit = await consumeTokenRateLimit(
    state.rateLimiter,
    authentication.tokenId,
    state.config.rateLimit,
  );
  if (!limit.allowed) {
    return rateLimited(limit.retryAfterSeconds);
  }
  if (
    (await authorizeWithAdminGuard(state.adminGuard, authentication.adminId, MCP_ACCESS)) ===
    'denied'
  ) {
    return accessDenied();
  }
  return serveProtocol(state, request, authentication);
}

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

async function serveProtocol(state: TransportState, request: Request, caller: Caller) {
  const parsed = await readJson(request);
  if (!parsed.ok) {
    return parseError();
  }
  // A batch would carry any number of tool calls through one rate-limited request.
  if (Array.isArray(parsed.body)) {
    return batchRefused();
  }
  // A stateless transport refuses a second request, so every request gets its own pair.
  const server = protocolServer(state, { ...caller, correlationId: randomUUID() });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return noStore(await transport.handleRequest(request, { parsedBody: parsed.body }));
  } finally {
    await server.close();
  }
}

// The SDK copies every request header, Authorization included, into each handler's
// `extra.requestInfo`, and sends a thrown error's message to the client verbatim: the handlers
// never read `extra` and never let an internal error escape.
function protocolServer(state: TransportState, call: ToolCall) {
  const server = new McpServer(
    { name: SERVER_NAME, version: state.kernel.catalogVersion },
    { capabilities: { tools: { listChanged: false } }, jsonSchemaValidator: state.validator },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, () => listTools(state, call));
  server.server.setRequestHandler(CallToolRequestSchema, (request) =>
    callTool(state, call, request.params),
  );
  return server;
}

async function listTools(state: TransportState, { adminId }: ToolCall) {
  try {
    const granted = await state.adminGuard.filterGranted(
      adminId,
      state.tools.map((tool) => ({ ...tool.iam, tool })),
    );
    return { tools: granted.map(({ tool }) => tool.definition) };
  } catch (err) {
    logger.error({ err }, 'mcp tools/list failed');
    throw new McpError(ErrorCode.InternalError, 'Internal error');
  }
}

async function callTool(state: TransportState, call: ToolCall, params: CallToolRequest['params']) {
  const tool = state.toolsByName.get(params.name);
  if (!tool) {
    throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
  }
  try {
    const result = await state.kernel.invokeTool(tool.id, params.arguments ?? {}, {
      runId: randomUUID(),
      actor: { kind: 'mcp_token', tokenId: call.tokenId, adminId: call.adminId },
      catalogVersion: state.kernel.catalogVersion,
      correlationId: call.correlationId,
    });
    await recordCall(state.authenticator, call);
    return toCallToolResult(result, tool.keys, call.correlationId);
  } catch (err) {
    logger.error({ err, toolId: tool.id }, 'mcp tools/call failed');
    return toCallToolResult({ ok: false, error: 'internal_error' }, tool.keys, call.correlationId);
  }
}

async function recordCall(authenticator: McpTokenAuthenticator, { tokenId }: ToolCall) {
  try {
    await authenticator.recordCall(tokenId);
  } catch (err) {
    logger.error({ err, tokenId }, 'mcp token call was not recorded');
  }
}

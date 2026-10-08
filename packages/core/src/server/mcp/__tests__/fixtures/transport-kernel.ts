import { vi } from 'vitest';
import * as z from 'zod';
import {
  MoneyAmountSchema,
  UuidSchema,
  defineMcpTool,
  type AuditWritePort,
  type McpToolHandler,
  type TokenCatalog,
} from '@openora/core/contracts';
import { Container } from '../../../kernel/index.js';
import { ModuleRegistryImpl } from '../../../plugin-host/module-registry.js';
import { createMcpKernel, type McpAuthorizer } from '../../kernel.js';

const summaryInput = z.object({ playerId: UuidSchema });

const summaryOutput = z
  .object({
    playerId: UuidSchema,
    email: z.string(),
    status: z.string(),
    balance: MoneyAmountSchema,
    note: z.string().optional(),
    riskScore: z.number(),
  })
  .refine((output) => output.status.length > 0, { message: 'status is required' });

export const playerSummaryTool = defineMcpTool({
  id: 'player.summary',
  title: 'Player summary',
  description: 'Status and balance of one player',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'player', action: 'view' },
  inputSchema: summaryInput,
  outputSchema: summaryOutput,
  redact: { allow: ['playerId', 'email', 'status', 'balance', 'note'], personal: ['email'] },
  errors: ['player_not_found'],
});

export const flagPlayerTool = defineMcpTool({
  id: 'player.flag',
  title: 'Flag player',
  description: 'Proposes a review flag on one player',
  class: 'propose',
  schemaVersion: 1,
  iam: { resource: 'player', action: 'update' },
  inputSchema: z.object({ playerId: UuidSchema }),
  outputSchema: z.object({ flagged: z.boolean() }),
  redact: { allow: ['flagged'] },
  errors: [],
});

export type SummaryHandler = McpToolHandler<typeof summaryInput, typeof summaryOutput>;

export const PLAYER_EMAIL = 'player@example.com';

export const summaryHandler: SummaryHandler = async ({ playerId }) => ({
  playerId,
  email: PLAYER_EMAIL,
  status: 'active',
  balance: '12.50',
  riskScore: 7,
});

function auditWriter() {
  return {
    record: vi.fn<AuditWritePort['record']>(async () => undefined),
    recordInTransaction: vi.fn<AuditWritePort['recordInTransaction']>(async () => undefined),
    recordManyInTransaction: vi.fn<AuditWritePort['recordManyInTransaction']>(
      async () => undefined,
    ),
  };
}

export function transportKernel({
  handler = summaryHandler,
  authorize = async () => 'allowed',
}: { handler?: SummaryHandler; authorize?: McpAuthorizer } = {}) {
  const registry = new ModuleRegistryImpl<TokenCatalog>(new Container());
  registry.setOwner('players');
  registry.mcp.tool(playerSummaryTool, () => handler);
  registry.mcp.tool(flagPlayerTool, () => async () => ({ flagged: true }));
  const audit = auditWriter();
  const kernel = createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container: new Container(),
    authorize,
    audit,
  });
  return { kernel, audit };
}

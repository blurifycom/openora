import * as z from 'zod';
import {
  defineActionType,
  defineMcpTool,
  UuidSchema,
  type TokenCatalog,
} from '@openora/core/contracts';
import type { Plugin } from '../../define-plugin.js';

const statusTool = defineMcpTool({
  id: 'withdrawal.status',
  title: 'Withdrawal status',
  description: 'Status of one withdrawal',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'withdrawal', action: 'view' },
  inputSchema: z.object({ withdrawalId: UuidSchema }),
  outputSchema: z.object({ status: z.string() }),
  redact: { allow: ['status'] },
  errors: [],
});

const holdAction = defineActionType({
  id: 'hold_withdrawal',
  title: 'Hold a withdrawal',
  description: 'Puts a pending withdrawal on hold for manual review',
  schemaVersion: 1,
  iam: { resource: 'withdrawal', action: 'hold' },
  reversible: true,
  payloadSchema: z.object({ withdrawalId: UuidSchema }),
  errors: [],
});

export default {
  id: 'agent-surface',
  register(ctx) {
    ctx.mcp.tool(statusTool, () => async () => ({ status: 'pending' }));
    ctx.actions.register(holdAction, () => ({
      precondition: async () => ({ ok: true }),
      execute: async () => ({ outcome: 'applied' }),
    }));
  },
} satisfies Plugin<TokenCatalog>;

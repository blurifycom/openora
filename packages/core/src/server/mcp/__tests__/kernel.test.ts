import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import {
  McpToolError,
  MoneyAmountSchema,
  UuidSchema,
  defineActionType,
  defineMcpTool,
  triggerCatalog,
  type ActionExecutionOutcome,
  type ActionTypeImplementation,
  type McpToolHandler,
  type RunContext,
  type TokenCatalog,
} from '@openora/core/contracts';
import { makeAuditWriter, mock } from '../../../testing/mock.js';
import { Container } from '../../kernel/index.js';
import { ModuleRegistryImpl } from '../../plugin-host/module-registry.js';
import { canonicalJson } from '../canonical-json.js';
import { createMcpKernel, type McpAuthorizer } from '../kernel.js';

const summaryInput = z.object({
  playerId: UuidSchema,
  limit: z.coerce.number().int().min(1).max(50),
});
const summaryOutput = z.object({
  playerId: UuidSchema,
  email: z.string(),
  balance: MoneyAmountSchema,
});

const summaryTool = defineMcpTool({
  id: 'player.summary',
  title: 'Player summary',
  description: 'Balance of one player',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'player', action: 'view' },
  inputSchema: summaryInput,
  outputSchema: summaryOutput,
  redact: { allow: ['playerId', 'balance'], personal: ['playerId'] },
  errors: ['player_not_found'],
});

const holdPayload = z.object({ withdrawalId: UuidSchema, reason: z.string().min(1).max(200) });

const holdWithdrawal = defineActionType({
  id: 'hold_withdrawal',
  title: 'Hold a withdrawal',
  description: 'Puts a pending withdrawal on hold for manual review',
  schemaVersion: 1,
  iam: { resource: 'withdrawal', action: 'hold' },
  reversible: true,
  payloadSchema: holdPayload,
  errors: ['withdrawal_not_pending'],
});

type SummaryHandler = McpToolHandler<typeof summaryInput, typeof summaryOutput>;
type HoldImplementation = ActionTypeImplementation<typeof holdPayload>;

const SQL_ERROR = 'SELECT email FROM players WHERE id=991';
const PLAYER_EMAIL = 'player@example.com';

const adminId = randomUUID();
const agentId = randomUUID();
const playerId = randomUUID();
const withdrawalId = randomUUID();

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

const runContext = (overrides: Partial<RunContext> = {}): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId, agentVersion: 3, onBehalfOf: adminId },
  playerPseudonym: 'player-7f3a',
  catalogVersion: 'catalog-1',
  correlationId: 'correlation-1',
  ...overrides,
});

const summaryHandler: SummaryHandler = async (input) => ({
  playerId: input.playerId,
  email: PLAYER_EMAIL,
  balance: '12.50',
});

function idempotentHold(): HoldImplementation {
  const applied = new Set<string>();
  return {
    precondition: vi.fn(async () => ({ ok: true as const })),
    execute: vi.fn(
      async (
        _payload: z.output<typeof holdPayload>,
        proposalId: string,
      ): Promise<ActionExecutionOutcome> => {
        if (applied.has(proposalId)) {
          return { outcome: 'already_applied' };
        }
        applied.add(proposalId);
        return { outcome: 'applied', detail: { held: true } };
      },
    ),
  };
}

function kernelOf(register: (registry: ModuleRegistryImpl<TokenCatalog>) => void) {
  const registry = new ModuleRegistryImpl<TokenCatalog>(new Container());
  register(registry);
  const audit = makeAuditWriter();
  const kernel = createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container: new Container(),
    authorize: async () => 'allowed',
    audit,
  });
  return { kernel, audit };
}

function setup({
  handler = summaryHandler,
  implementation = idempotentHold(),
  authorize = async () => 'allowed',
  audit = makeAuditWriter(),
}: {
  handler?: SummaryHandler;
  implementation?: HoldImplementation;
  authorize?: McpAuthorizer;
  audit?: ReturnType<typeof makeAuditWriter> | null;
} = {}) {
  const handlerSpy = vi.fn(handler);
  const toolFactory = vi.fn(() => handlerSpy);
  const actionFactory = vi.fn(() => implementation);
  const authorizeSpy = vi.fn(authorize);
  const registry = new ModuleRegistryImpl(new Container());
  registry.setOwner('players');
  registry.mcp.tool(summaryTool, toolFactory);
  registry.setOwner('wallet');
  registry.actions.register(holdWithdrawal, actionFactory);
  const kernel = createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container: new Container(),
    authorize: authorizeSpy,
    audit,
  });
  return {
    kernel,
    handler: handlerSpy,
    toolFactory,
    actionFactory,
    implementation,
    authorize: authorizeSpy,
    audit,
  };
}

describe('McpKernel.invokeTool', () => {
  it('returns only the allow-listed output keys, with the input coerced by its schema', async () => {
    const { kernel, handler } = setup();
    const run = runContext();

    const result = await kernel.invokeTool('player.summary', { playerId, limit: '5' }, run);

    expect(result).toEqual({ ok: true, output: { playerId, balance: '12.50' } });
    expect(handler).toHaveBeenCalledWith({ playerId, limit: 5 }, run);
  });

  it('audits the call with hashes of the parsed input and the redacted output, never the data', async () => {
    const { kernel, audit } = setup();
    const run = runContext();

    await kernel.invokeTool('player.summary', { playerId, limit: '5', extra: 'dropped' }, run);

    expect(audit?.record).toHaveBeenCalledTimes(1);
    expect(audit?.record).toHaveBeenCalledWith({
      actorId: adminId,
      actorType: 'admin',
      action: 'mcp.tool.invoked',
      resourceType: 'mcp-tool',
      resourceId: 'player.summary',
      correlationId: 'correlation-1',
      after: {
        toolId: 'player.summary',
        toolClass: 'read',
        schemaVersion: 1,
        runId: run.runId,
        actorKind: 'agent',
        agentId,
        agentVersion: 3,
        playerPseudonym: 'player-7f3a',
        catalogVersion: 'catalog-1',
        inputHash: sha256({ limit: 5, playerId }),
        outputHash: sha256({ balance: '12.50', playerId }),
      },
    });
    const audited = JSON.stringify(audit?.record.mock.calls);
    expect(audited).not.toContain(playerId);
    expect(audited).not.toContain(PLAYER_EMAIL);
  });

  it('records the token and its owner for an MCP token actor', async () => {
    const { kernel, audit, authorize } = setup();
    const tokenId = randomUUID();

    await kernel.invokeTool(
      'player.summary',
      { playerId, limit: 1 },
      runContext({ actor: { kind: 'mcp_token', tokenId, adminId }, playerPseudonym: undefined }),
    );

    expect(authorize).toHaveBeenCalledWith(adminId, { resource: 'player', action: 'view' });
    expect(audit?.record.mock.calls[0]?.[0].after).toMatchObject({
      actorKind: 'mcp_token',
      tokenId,
    });
    expect(audit?.record.mock.calls[0]?.[0].after).not.toHaveProperty('playerPseudonym');
  });

  it('turns a thrown database error into internal_error without its message anywhere', async () => {
    const { kernel, audit } = setup({
      handler: async () => {
        throw new Error(SQL_ERROR);
      },
    });

    const result = await kernel.invokeTool('player.summary', { playerId, limit: 5 }, runContext());

    expect(result).toEqual({ ok: false, error: 'internal_error' });
    expect(JSON.stringify(result)).not.toContain('SELECT');
    expect(JSON.stringify(audit?.record.mock.calls)).not.toContain('SELECT');
    expect(audit?.record.mock.calls[0]?.[0]).toMatchObject({
      action: 'mcp.tool.failed',
      after: { error: 'internal_error' },
    });
  });

  it('returns a declared McpToolError code', async () => {
    const { kernel } = setup({
      handler: async () => {
        throw new McpToolError('player_not_found');
      },
    });

    await expect(
      kernel.invokeTool('player.summary', { playerId, limit: 5 }, runContext()),
    ).resolves.toEqual({ ok: false, error: 'player_not_found' });
  });

  it('turns an undeclared McpToolError code into internal_error', async () => {
    const { kernel } = setup({
      handler: async () => {
        throw new McpToolError('wallet_frozen');
      },
    });

    await expect(
      kernel.invokeTool('player.summary', { playerId, limit: 5 }, runContext()),
    ).resolves.toEqual({ ok: false, error: 'internal_error' });
  });

  it('refuses output that fails its schema without echoing it', async () => {
    const leaked = 'sk_live_output_secret';
    const { kernel, audit } = setup({
      handler: async () => ({ playerId: leaked, email: PLAYER_EMAIL, balance: '12.50' }),
    });

    const result = await kernel.invokeTool('player.summary', { playerId, limit: 5 }, runContext());

    expect(result).toEqual({ ok: false, error: 'output_invalid' });
    expect(JSON.stringify(audit?.record.mock.calls)).not.toContain(leaked);
  });

  it('refuses a caller without the grant before the handler runs', async () => {
    const { kernel, handler, audit } = setup({ authorize: async () => 'denied' });

    const result = await kernel.invokeTool('player.summary', { playerId, limit: 5 }, runContext());

    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
    expect(audit?.record.mock.calls[0]?.[0]).toMatchObject({
      action: 'mcp.tool.failed',
      after: { error: 'forbidden', inputHash: sha256({ limit: 5, playerId }) },
    });
  });

  it('fails closed when authorization itself throws', async () => {
    const { kernel, handler } = setup({
      authorize: async () => {
        throw new Error('iam store unreachable');
      },
    });

    await expect(
      kernel.invokeTool('player.summary', { playerId, limit: 5 }, runContext()),
    ).resolves.toEqual({ ok: false, error: 'internal_error' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports each invalid field by path, never by value', async () => {
    const { kernel, handler } = setup();

    const result = await kernel.invokeTool(
      'player.summary',
      { playerId: PLAYER_EMAIL, limit: '5000' },
      runContext(),
    );

    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(result.ok ? [] : result.issues?.map(({ path }) => path)).toEqual(['playerId', 'limit']);
    expect(JSON.stringify(result)).not.toContain(PLAYER_EMAIL);
    expect(handler).not.toHaveBeenCalled();
  });

  it('turns a schema refinement that throws into internal_error', async () => {
    const { kernel, audit } = kernelOf((registry) => {
      registry.mcp.tool(
        defineMcpTool({
          ...summaryTool,
          id: 'player.flaky',
          inputSchema: summaryInput.superRefine(() => {
            throw new Error(SQL_ERROR);
          }),
        }),
        () => summaryHandler,
      );
    });

    const result = await kernel.invokeTool('player.flaky', { playerId, limit: 5 }, runContext());

    expect(result).toEqual({ ok: false, error: 'internal_error' });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('SELECT');
  });

  it('refuses an invalid run context without auditing or running anything', async () => {
    const { kernel, handler, authorize, audit } = setup();

    const result = await kernel.invokeTool(
      'player.summary',
      { playerId, limit: 5 },
      { ...runContext(), correlationId: '' },
    );

    expect(result).toEqual({ ok: false, error: 'invalid_run_context' });
    expect(authorize).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(audit?.record).not.toHaveBeenCalled();
  });

  it('audits a call to a tool that is not registered', async () => {
    const { kernel, audit } = setup();

    const result = await kernel.invokeTool('player.delete', {}, runContext());

    expect(result).toEqual({ ok: false, error: 'unknown_tool' });
    expect(audit?.record.mock.calls[0]?.[0]).toMatchObject({
      action: 'mcp.tool.failed',
      resourceId: 'player.delete',
      after: { toolId: 'player.delete', error: 'unknown_tool', inputHash: sha256({}) },
    });
  });

  it('withholds a successful result when the audit write fails', async () => {
    const audit = makeAuditWriter();
    audit.record.mockRejectedValueOnce(new Error('audit store down'));
    const { kernel } = setup({ audit });

    await expect(
      kernel.invokeTool('player.summary', { playerId, limit: 5 }, runContext()),
    ).resolves.toEqual({ ok: false, error: 'audit_unavailable' });
  });

  it('withholds every result when no audit writer is bound', async () => {
    const { kernel, handler } = setup({ audit: null });

    await expect(
      kernel.invokeTool('player.summary', { playerId, limit: 5 }, runContext()),
    ).resolves.toEqual({ ok: false, error: 'audit_unavailable' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('McpKernel.checkPrecondition', () => {
  const payload = { withdrawalId, reason: 'velocity spike' };

  it('passes a satisfied precondition without IAM or audit', async () => {
    const { kernel, authorize, audit } = setup();

    await expect(
      kernel.checkPrecondition('hold_withdrawal', payload, runContext()),
    ).resolves.toEqual({ ok: true });
    expect(authorize).not.toHaveBeenCalled();
    expect(audit?.record).not.toHaveBeenCalled();
  });

  it('returns a declared refusal code', async () => {
    const { kernel } = setup({
      implementation: {
        ...idempotentHold(),
        precondition: async () => ({ ok: false, code: 'withdrawal_not_pending' }),
      },
    });

    await expect(
      kernel.checkPrecondition('hold_withdrawal', payload, runContext()),
    ).resolves.toEqual({ ok: false, error: 'withdrawal_not_pending' });
  });

  it('fails closed on an undeclared refusal code', async () => {
    const { kernel } = setup({
      implementation: {
        ...idempotentHold(),
        precondition: async () => ({ ok: false, code: 'player_is_vip' }),
      },
    });

    await expect(
      kernel.checkPrecondition('hold_withdrawal', payload, runContext()),
    ).resolves.toEqual({ ok: false, error: 'internal_error' });
  });

  it('fails closed when the precondition throws', async () => {
    const { kernel } = setup({
      implementation: {
        ...idempotentHold(),
        precondition: async () => {
          throw new Error(SQL_ERROR);
        },
      },
    });

    const result = await kernel.checkPrecondition('hold_withdrawal', payload, runContext());

    expect(result).toEqual({ ok: false, error: 'internal_error' });
  });

  it('reports an unknown action type and an invalid payload', async () => {
    const { kernel } = setup();

    await expect(kernel.checkPrecondition('ban_player', payload, runContext())).resolves.toEqual({
      ok: false,
      error: 'unknown_action',
    });
    await expect(
      kernel.checkPrecondition('hold_withdrawal', { withdrawalId }, runContext()),
    ).resolves.toMatchObject({ ok: false, error: 'invalid_input', issues: [{ path: 'reason' }] });
  });
});

describe('McpKernel.executeAction', () => {
  const payload = { withdrawalId, reason: 'velocity spike' };
  const approver = { kind: 'admin', adminId } as const;

  it('applies once and answers a replay with already_applied, auditing both', async () => {
    const { kernel, audit, implementation } = setup();
    const context = { proposalId: randomUUID(), actor: approver, correlationId: 'correlation-2' };

    const first = await kernel.executeAction('hold_withdrawal', payload, context);
    const replay = await kernel.executeAction('hold_withdrawal', payload, context);

    expect(first).toEqual({ ok: true, outcome: 'applied', detail: { held: true } });
    expect(replay).toEqual({ ok: true, outcome: 'already_applied' });
    expect(implementation.execute).toHaveBeenCalledTimes(2);
    expect(implementation.precondition).not.toHaveBeenCalled();
    expect(audit?.record.mock.calls.map(([entry]) => entry)).toEqual(
      ['applied', 'already_applied'].map((outcome) => ({
        actorId: adminId,
        actorType: 'admin',
        action: 'mcp.action.executed',
        resourceType: 'agent-proposal',
        resourceId: context.proposalId,
        correlationId: 'correlation-2',
        after: {
          actionTypeId: 'hold_withdrawal',
          schemaVersion: 1,
          proposalId: context.proposalId,
          actorKind: 'admin',
          payloadHash: sha256(payload),
          outcome,
        },
      })),
    );
  });

  it('refuses an approver without the grant and never runs the executor', async () => {
    const { kernel, implementation, audit } = setup({ authorize: async () => 'denied' });
    const proposalId = randomUUID();

    const result = await kernel.executeAction('hold_withdrawal', payload, {
      proposalId,
      actor: approver,
      correlationId: 'correlation-3',
    });

    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(implementation.execute).not.toHaveBeenCalled();
    expect(audit?.record.mock.calls[0]?.[0]).toMatchObject({
      action: 'mcp.action.failed',
      resourceId: proposalId,
      after: { error: 'forbidden' },
    });
  });

  it('turns an executor failure into internal_error without its message', async () => {
    const { kernel, audit } = setup({
      implementation: {
        ...idempotentHold(),
        execute: async () => {
          throw new Error(SQL_ERROR);
        },
      },
    });

    const result = await kernel.executeAction('hold_withdrawal', payload, {
      proposalId: randomUUID(),
      actor: approver,
      correlationId: 'correlation-4',
    });

    expect(result).toEqual({ ok: false, error: 'internal_error' });
    expect(JSON.stringify(audit?.record.mock.calls)).not.toContain('SELECT');
  });

  it('refuses a malformed proposal id without auditing', async () => {
    const { kernel, audit, implementation } = setup();

    const result = await kernel.executeAction('hold_withdrawal', payload, {
      proposalId: 'proposal-1',
      actor: approver,
      correlationId: 'correlation-5',
    });

    expect(result).toEqual({ ok: false, error: 'invalid_run_context' });
    expect(implementation.execute).not.toHaveBeenCalled();
    expect(audit?.record).not.toHaveBeenCalled();
  });

  it('retries a failed audit write after the executor ran instead of failing an applied action', async () => {
    const audit = makeAuditWriter();
    audit.record.mockRejectedValueOnce(new Error('audit store blip'));
    const { kernel } = setup({ audit });
    const context = { proposalId: randomUUID(), actor: approver, correlationId: 'correlation-6' };

    const result = await kernel.executeAction('hold_withdrawal', payload, context);

    expect(result).toMatchObject({ ok: true, outcome: 'applied' });
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record.mock.calls[1]?.[0]).toMatchObject({ action: 'mcp.action.executed' });
  });

  it('asks the caller to retry when every audit write attempt fails after the executor ran', async () => {
    const audit = makeAuditWriter();
    audit.record
      .mockRejectedValueOnce(new Error('audit store down'))
      .mockRejectedValueOnce(new Error('audit store down'))
      .mockRejectedValueOnce(new Error('audit store down'));
    const { kernel } = setup({ audit });
    const context = { proposalId: randomUUID(), actor: approver, correlationId: 'correlation-7' };

    const first = await kernel.executeAction('hold_withdrawal', payload, context);
    const retry = await kernel.executeAction('hold_withdrawal', payload, context);

    expect(first).toEqual({ ok: false, error: 'audit_unavailable' });
    expect(retry).toEqual({ ok: true, outcome: 'already_applied' });
  });
});

describe('McpKernel catalog', () => {
  it('describes each tool and action type with its owner, model name and JSON Schemas', () => {
    const { kernel } = setup();

    expect(kernel.listTools()).toEqual([
      expect.objectContaining({
        id: 'player.summary',
        owner: 'players',
        modelName: 'player_summary',
        inputJsonSchema: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({ limit: expect.objectContaining({ maximum: 50 }) }),
        }),
        outputJsonSchema: expect.objectContaining({
          type: 'object',
          required: ['playerId', 'balance'],
        }),
      }),
    ]);
    expect(kernel.listTools()[0]?.outputJsonSchema).not.toHaveProperty('properties.email');
    expect(kernel.listActionTypes()).toEqual([
      expect.objectContaining({
        id: 'hold_withdrawal',
        owner: 'wallet',
        payloadJsonSchema: expect.objectContaining({ required: ['withdrawalId', 'reason'] }),
      }),
    ]);
    expect(kernel.listTriggers()).toBe(triggerCatalog());
  });

  it('runs each factory once, when the kernel is built', async () => {
    const { kernel, toolFactory, actionFactory } = setup();

    await kernel.invokeTool('player.summary', { playerId, limit: 5 }, runContext());
    await kernel.invokeTool('player.summary', { playerId, limit: 6 }, runContext());

    expect(toolFactory).toHaveBeenCalledTimes(1);
    expect(actionFactory).toHaveBeenCalledTimes(1);
  });

  it('versions the catalog by id and schema version, not by registration order', () => {
    const toolFirst = kernelOf((registry) => {
      registry.mcp.tool(summaryTool, () => summaryHandler);
      registry.actions.register(holdWithdrawal, idempotentHold);
    }).kernel.catalogVersion;
    const actionFirst = kernelOf((registry) => {
      registry.actions.register(holdWithdrawal, idempotentHold);
      registry.mcp.tool(summaryTool, () => summaryHandler);
    }).kernel.catalogVersion;
    const bumped = kernelOf((registry) => {
      registry.mcp.tool(defineMcpTool({ ...summaryTool, schemaVersion: 2 }), () => summaryHandler);
      registry.actions.register(holdWithdrawal, idempotentHold);
    }).kernel.catalogVersion;

    expect(toolFirst).toMatch(/^[0-9a-f]{16}$/);
    expect(actionFirst).toBe(toolFirst);
    expect(bumped).not.toBe(toolFirst);
  });

  it('fails the build when a factory returns no handler', () => {
    expect(() =>
      kernelOf((registry) => {
        registry.mcp.tool(summaryTool, () => mock<SummaryHandler>());
      }),
    ).toThrow(/tool "player\.summary" \(plugin "unknown"\): factory returned no handler/);
  });
});

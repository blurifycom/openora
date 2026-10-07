import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import {
  MCP_KERNEL,
  type ActionExecutionContext,
  type McpKernel,
  type McpToolResult,
  type RunContext,
} from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { kycVerification } from '@openora/core/compliance/schema';
import { user } from '@openora/core/pam/schema/identity';
import { playerTag, tag } from '@openora/core/pam/schema/tag';
import { walletTransaction } from '@openora/core/wallet/schema';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  asAdmin,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let kernel: McpKernel;
let admin: TestClient;
let adminId: string;

const SEEDED_ADMIN_EMAIL = 'admin@oss.dev';
const REQUEST_BODY_NESTING = 400_000;
const SQL_ERROR = 'SELECT email FROM player WHERE id = 991';

const EXPECTED_TOOL_OWNERS = {
  'ggr.summary': 'analytics',
  'kyc.status': 'compliance',
  'player.summary': 'player-management',
  'wallet.activity': 'wallet',
} as const;

const EXPECTED_ACTION_OWNERS = {
  add_note: 'player-note',
  add_tag: 'tag',
  hold_withdrawal: 'wallet',
  request_enhanced_kyc: 'compliance',
  send_to_manual_review: 'tag',
} as const;

// Parsing keeps only the fields both sides carry: `module` and `file` are the generator's own.
const CatalogIamSchema = z.object({ resource: z.string(), action: z.string() }).nullable();

const GeneratedAgentSurfaceSchema = z.object({
  agentTools: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      description: z.string().nullable(),
      class: z.string().nullable(),
      schemaVersion: z.number().nullable(),
      iam: CatalogIamSchema,
    }),
  ),
  agentActions: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      description: z.string().nullable(),
      schemaVersion: z.number().nullable(),
      iam: CatalogIamSchema,
      reversible: z.boolean().nullable(),
    }),
  ),
});

const GENERATED_CATALOG_PATHS = [
  '../../../../docs/catalog.json',
  '../../../mcp/docs/catalog.json',
] as const;

function readGeneratedAgentSurface() {
  for (const relative of GENERATED_CATALOG_PATHS) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) {
      return GeneratedAgentSurfaceSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    }
  }
  throw new Error(
    'no generated catalog.json - run `pnpm gen:catalog` (`pnpm install` also runs it)',
  );
}

function nestedArrays(levels: number): unknown {
  let value: unknown = randomUUID();
  for (let level = 0; level < levels; level += 1) {
    value = [value];
  }
  return value;
}

function unreadableInput(): Record<string, unknown> {
  return Object.defineProperty({}, 'playerId', {
    enumerable: true,
    get() {
      throw new Error(SQL_ERROR);
    },
  });
}

function byId<T extends { id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => left.id.localeCompare(right.id));
}

// A fresh correlation id per call is what lets a test find the one audit row that call wrote.
function adminRun(actingAdminId: string): RunContext {
  return {
    runId: randomUUID(),
    actor: { kind: 'admin', adminId: actingAdminId },
    catalogVersion: kernel.catalogVersion,
    correlationId: `mcp-e2e-${randomUUID()}`,
  };
}

function execution(proposalId: string): ActionExecutionContext {
  return {
    proposalId,
    actor: { kind: 'admin', adminId },
    correlationId: `mcp-e2e-${randomUUID()}`,
  };
}

function outputOf(result: McpToolResult): Record<string, unknown> {
  if (!result.ok) {
    throw new Error(`expected an ok tool result, got ${result.error}`);
  }
  return result.output;
}

function servedTool(toolId: string) {
  const served = kernel.listTools().find((tool) => tool.id === toolId);
  if (!served) {
    throw new Error(`tool ${toolId} is not served`);
  }
  return served;
}

function allowListOf(toolId: string): string[] {
  return [...servedTool(toolId).redact.allow].sort();
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`expected "${key}" to be a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

// Amounts come back as fixed-scale decimal strings (eg `30.000000000000000000`).
function wholeAmount(units: number): RegExp {
  return new RegExp(`^${units}(\\.0+)?$`);
}

const drizzle = () => app.container.get(DRIZZLE).db;

function auditRowsOfCall(correlationId: string) {
  return drizzle()
    .select()
    .from(auditLog)
    .where(eq(auditLog.correlationId, correlationId))
    .orderBy(asc(auditLog.seq));
}

function auditRowsOf(action: string, resourceId: string) {
  return drizzle()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)))
    .orderBy(asc(auditLog.seq));
}

async function withdrawalRow(withdrawalId: string) {
  const [row] = await drizzle()
    .select({
      status: walletTransaction.status,
      reviewedBy: walletTransaction.reviewedBy,
      reviewReason: walletTransaction.reviewReason,
    })
    .from(walletTransaction)
    .where(eq(walletTransaction.id, withdrawalId));
  if (!row) {
    throw new Error(`no wallet_transaction row ${withdrawalId}`);
  }
  return row;
}

function vipTagRows(playerId: string) {
  return drizzle()
    .select({ id: playerTag.id, removedAt: playerTag.removedAt })
    .from(playerTag)
    .innerJoin(tag, eq(tag.id, playerTag.tagId))
    .where(and(eq(playerTag.playerId, playerId), eq(tag.key, 'vip')));
}

// player-note exports no schema subpath, so its rows are read by table name.
async function noteIdsOf(playerId: string): Promise<string[]> {
  const result = await drizzle().execute<{ id: string }>(
    sql`SELECT id FROM player_note WHERE player_id = ${playerId}`,
  );
  return result.rows.map((row) => row.id);
}

function advancedKycRows(userId: string) {
  return drizzle()
    .select({ status: kycVerification.status, triggeredBy: kycVerification.triggeredBy })
    .from(kycVerification)
    .where(and(eq(kycVerification.userId, userId), eq(kycVerification.tier, 'advanced')));
}

async function newPlayer(label: string) {
  const email = `mcp-${label}-${randomUUID()}@e2e.test`;
  return { email, ...(await registerAndMaterializePlayer(app, { email })) };
}

async function depositUsd(client: TestClient, amount: string) {
  const res = await client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount,
    currency: 'USD',
  });
  expect(res.status).toBe(200);
}

async function requestUsdWithdrawal(client: TestClient, amount: string): Promise<string> {
  const res = await client.post('/wallet/withdraw', {
    idempotencyKey: randomUUID(),
    amount,
    currency: 'USD',
  });
  expect(res.status).toBe(200);
  const body = object(await res.json());
  // An auto-approved withdrawal never reaches the queue these flows act on.
  expect(body['status']).toBe('pending');
  return stringField(body, 'transactionId');
}

async function usdBalance(client: TestClient): Promise<string> {
  const res = await client.get('/wallet/balances');
  expect(res.status).toBe(200);
  const balances = object(await res.json())['balances'];
  if (!Array.isArray(balances)) {
    throw new Error(`expected a balances array, got ${JSON.stringify(balances)}`);
  }
  const usd = balances.map(object).find((entry) => entry['currency'] === 'USD');
  if (!usd) {
    throw new Error('no USD balance');
  }
  return stringField(usd, 'balance');
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
  kernel = app.container.get(MCP_KERNEL);

  const [seededAdmin] = await drizzle()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, SEEDED_ADMIN_EMAIL));
  if (!seededAdmin) {
    throw new Error('the seeded admin is missing');
  }
  adminId = seededAdmin.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('MCP kernel registries match the generated catalog', () => {
  it('serves exactly the four read tools and five action types, each under its owning plugin', () => {
    const tools = kernel.listTools();
    const actions = kernel.listActionTypes();

    expect(tools).toHaveLength(Object.keys(EXPECTED_TOOL_OWNERS).length);
    expect(Object.fromEntries(tools.map((tool) => [tool.id, tool.owner]))).toEqual(
      EXPECTED_TOOL_OWNERS,
    );
    expect(actions).toHaveLength(Object.keys(EXPECTED_ACTION_OWNERS).length);
    expect(Object.fromEntries(actions.map((action) => [action.id, action.owner]))).toEqual(
      EXPECTED_ACTION_OWNERS,
    );
    expect(tools.every((tool) => tool.class === 'read')).toBe(true);
    expect(kernel.catalogVersion).toMatch(/^[0-9a-f]{16}$/);
  });

  it('serves the same ids, titles, descriptions, versions and IAM grants the static catalog advertises', () => {
    const generated = readGeneratedAgentSurface();

    const servedTools = kernel.listTools().map((tool) => ({
      id: tool.id,
      title: tool.title,
      description: tool.description,
      class: tool.class,
      schemaVersion: tool.schemaVersion,
      iam: { resource: tool.iam.resource, action: tool.iam.action },
    }));
    const servedActions = kernel.listActionTypes().map((action) => ({
      id: action.id,
      title: action.title,
      description: action.description,
      schemaVersion: action.schemaVersion,
      iam: { resource: action.iam.resource, action: action.iam.action },
      reversible: action.reversible,
    }));

    expect(byId(generated.agentTools).map((entry) => entry.id)).toEqual(
      byId(servedTools).map((entry) => entry.id),
    );
    expect(byId(generated.agentActions).map((entry) => entry.id)).toEqual(
      byId(servedActions).map((entry) => entry.id),
    );
    expect(byId(generated.agentTools)).toEqual(byId(servedTools));
    expect(byId(generated.agentActions)).toEqual(byId(servedActions));
  });
});

describe('MCP read tools are IAM-checked, allow-listed and audited by hash', () => {
  let target: Awaited<ReturnType<typeof newPlayer>>;
  let intruder: Awaited<ReturnType<typeof newPlayer>>;

  beforeAll(async () => {
    target = await newPlayer('summary-target');
    intruder = await newPlayer('summary-intruder');
  });

  it('returns only the allow-listed player.summary keys and audits the call without its raw input', async () => {
    const run = adminRun(adminId);

    const output = outputOf(
      await kernel.invokeTool('player.summary', { playerId: target.playerId }, run),
    );

    expect(Object.keys(output).sort()).toEqual(allowListOf('player.summary'));
    expect(output).toMatchObject({
      playerId: target.playerId,
      userId: target.userId,
      email: target.email,
      tags: expect.any(Array),
    });

    const rows = await auditRowsOfCall(run.correlationId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      action: 'mcp.tool.invoked',
      actorId: adminId,
      actorType: 'admin',
      resourceType: 'mcp-tool',
      resourceId: 'player.summary',
      before: null,
    });
    expect(row?.after).toMatchObject({
      toolId: 'player.summary',
      toolClass: 'read',
      schemaVersion: servedTool('player.summary').schemaVersion,
      runId: run.runId,
      actorKind: 'admin',
      catalogVersion: kernel.catalogVersion,
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const recorded = JSON.stringify(row?.after);
    expect(recorded).not.toContain(target.playerId);
    expect(recorded).not.toContain(target.email);
  });

  it("refuses a player's user id acting as an admin and records the refusal and the IAM denial", async () => {
    const run = adminRun(intruder.userId);

    const result = await kernel.invokeTool('player.summary', { playerId: target.playerId }, run);

    expect(result).toEqual({ ok: false, error: 'forbidden' });

    const rows = await auditRowsOfCall(run.correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'mcp.tool.failed',
      actorId: intruder.userId,
      resourceType: 'mcp-tool',
      resourceId: 'player.summary',
    });
    expect(rows[0]?.after).toMatchObject({
      toolId: 'player.summary',
      error: 'forbidden',
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(rows[0]?.after).not.toHaveProperty('outputHash');

    // AdminGuard emits the denial as an event, so its audit row lands asynchronously.
    await vi.waitFor(
      async () => {
        const denials = await auditRowsOf('identity.user.unauthorized_access', 'player:view');
        expect(denials).toContainEqual(
          expect.objectContaining({
            actorType: 'player',
            actorId: intruder.playerId,
            resourceType: 'player',
            result: 'failure',
          }),
        );
      },
      { timeout: 15_000, interval: 100 },
    );
  });

  it('answers ggr.summary with exactly its declared keys and refuses an inverted range as invalid input', async () => {
    const input = { dateFrom: '2026-01-01', dateTo: '2026-03-31', granularity: 'month' };

    const output = outputOf(await kernel.invokeTool('ggr.summary', input, adminRun(adminId)));

    expect(Object.keys(output).sort()).toEqual(allowListOf('ggr.summary'));
    expect(output).toMatchObject({ ...input, series: expect.any(Array) });

    const inverted = adminRun(adminId);
    const refusal = await kernel.invokeTool(
      'ggr.summary',
      { dateFrom: '2026-03-31', dateTo: '2026-01-01' },
      inverted,
    );
    expect(refusal).toMatchObject({
      ok: false,
      error: 'invalid_input',
      issues: [expect.objectContaining({ path: 'dateFrom' })],
    });
    const rows = await auditRowsOfCall(inverted.correlationId);
    expect(rows.map((row) => row.action)).toEqual(['mcp.tool.failed']);
  });

  it('refuses and audits an input nested deeper than the call stack reaches', async () => {
    const run = adminRun(adminId);

    const result = await kernel.invokeTool(
      'player.summary',
      nestedArrays(REQUEST_BODY_NESTING),
      run,
    );

    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
    const rows = await auditRowsOfCall(run.correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'mcp.tool.failed',
      actorId: adminId,
      resourceType: 'mcp-tool',
      resourceId: 'player.summary',
    });
    expect(rows[0]?.after).toMatchObject({
      error: 'invalid_input',
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('answers internal_error and still writes the one audit row when a call throws outside its handler', async () => {
    const run = adminRun(adminId);

    const result = await kernel.invokeTool('player.summary', unreadableInput(), run);

    expect(result).toEqual({ ok: false, error: 'internal_error' });
    const rows = await auditRowsOfCall(run.correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'mcp.tool.failed', resourceId: 'player.summary' });
    expect(rows[0]?.after).toMatchObject({ error: 'internal_error' });
    expect(rows[0]?.after).not.toHaveProperty('inputHash');
    expect(JSON.stringify(rows[0])).not.toContain(SQL_ERROR);
  });
});

describe('an agent-proposed withdrawal hold, then an admin decision', () => {
  const holdReason = 'agent flagged a deposit-and-withdraw cycle for review';
  const holdProposalId = randomUUID();
  let holder: Awaited<ReturnType<typeof newPlayer>>;
  let heldWithdrawalId: string;

  beforeAll(async () => {
    holder = await newPlayer('withdrawal-holder');
    await depositUsd(holder.client, '50');
    heldWithdrawalId = await requestUsdWithdrawal(holder.client, '20');
  });

  it('lists the pending withdrawal in wallet.activity, with only the allow-listed keys', async () => {
    const output = outputOf(
      await kernel.invokeTool('wallet.activity', { playerId: holder.playerId }, adminRun(adminId)),
    );

    expect(Object.keys(output).sort()).toEqual(allowListOf('wallet.activity'));
    expect(output['openWithdrawals']).toEqual([
      expect.objectContaining({
        withdrawalId: heldWithdrawalId,
        status: 'pending',
        currency: 'USD',
        amount: expect.stringMatching(wholeAmount(20)),
      }),
    ]);
    expect(output['totals']).toContainEqual(
      expect.objectContaining({
        currency: 'USD',
        depositCount: 1,
        deposits: expect.stringMatching(wholeAmount(50)),
      }),
    );
  });

  it('holds the pending withdrawal exactly once when the approved proposal is replayed', async () => {
    const payload = {
      playerId: holder.playerId,
      withdrawalId: heldWithdrawalId,
      reason: holdReason,
    };
    const evaluation = adminRun(adminId);

    expect(await kernel.checkPrecondition('hold_withdrawal', payload, evaluation)).toEqual({
      ok: true,
    });
    expect(await auditRowsOfCall(evaluation.correlationId)).toHaveLength(0);

    expect(
      await kernel.executeAction('hold_withdrawal', payload, execution(holdProposalId)),
    ).toEqual({ ok: true, outcome: 'applied' });
    expect(
      await kernel.executeAction('hold_withdrawal', payload, execution(holdProposalId)),
    ).toEqual({ ok: true, outcome: 'already_applied' });

    expect(await withdrawalRow(heldWithdrawalId)).toEqual({
      status: 'on_hold',
      reviewedBy: adminId,
      reviewReason: holdReason,
    });

    const held = await auditRowsOf('wallet.withdrawal.held', holder.playerId);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      actorId: adminId,
      resourceType: 'player',
      before: { status: 'pending' },
      after: {
        transactionId: heldWithdrawalId,
        status: 'on_hold',
        reason: holdReason,
        proposalId: holdProposalId,
      },
    });

    const executed = await auditRowsOf('mcp.action.executed', holdProposalId);
    expect(executed).toHaveLength(2);
    expect(executed.map((row) => row.after?.['outcome'])).toEqual(['applied', 'already_applied']);
    for (const row of executed) {
      expect(row).toMatchObject({
        actorId: adminId,
        resourceType: 'agent-proposal',
        after: { actionTypeId: 'hold_withdrawal', proposalId: holdProposalId },
      });
    }
  });

  it('refuses to hold a withdrawal that is no longer pending, which activity lists as on hold', async () => {
    const payload = {
      playerId: holder.playerId,
      withdrawalId: heldWithdrawalId,
      reason: holdReason,
    };

    expect(await kernel.checkPrecondition('hold_withdrawal', payload, adminRun(adminId))).toEqual({
      ok: false,
      error: 'withdrawal_not_pending',
    });

    const output = outputOf(
      await kernel.invokeTool('wallet.activity', { playerId: holder.playerId }, adminRun(adminId)),
    );
    expect(output['openWithdrawals']).toEqual([
      expect.objectContaining({ withdrawalId: heldWithdrawalId, status: 'on_hold' }),
    ]);
  });

  it('forbids the player the approve route, then lets an admin approve the held withdrawal', async () => {
    const approvePath = `/wallet/withdrawals/${heldWithdrawalId}/approve`;

    const forbidden = await holder.client.post(approvePath, {});
    expect(forbidden.status).toBe(403);
    expect((await withdrawalRow(heldWithdrawalId)).status).toBe('on_hold');

    const approved = await admin.post(approvePath, {});
    expect(approved.status).toBe(200);
    // The default extensions bind the mock payment adapter, which settles a payout at once.
    expect(object(await approved.json())).toEqual({
      transactionId: heldWithdrawalId,
      status: 'completed',
    });
    expect((await withdrawalRow(heldWithdrawalId)).status).toBe('completed');
  });

  it('returns the funds of a rejected held withdrawal exactly once', async () => {
    const rejecting = await newPlayer('withdrawal-rejected');
    await depositUsd(rejecting.client, '50');
    const withdrawalId = await requestUsdWithdrawal(rejecting.client, '20');
    const payload = { playerId: rejecting.playerId, withdrawalId, reason: holdReason };
    expect(await kernel.executeAction('hold_withdrawal', payload, execution(randomUUID()))).toEqual(
      { ok: true, outcome: 'applied' },
    );
    expect((await withdrawalRow(withdrawalId)).status).toBe('on_hold');
    expect(await usdBalance(rejecting.client)).toMatch(wholeAmount(30));

    const rejectPath = `/wallet/withdrawals/${withdrawalId}/reject`;
    const rejected = await admin.post(rejectPath, { reason: 'held payout declined on review' });
    expect(rejected.status).toBe(200);
    expect(object(await rejected.json())).toEqual({
      transactionId: withdrawalId,
      status: 'rejected',
    });
    expect(await usdBalance(rejecting.client)).toMatch(wholeAmount(50));

    const repeated = await admin.post(rejectPath, { reason: 'held payout declined on review' });
    expect(repeated.status).toBe(409);
    expect(await usdBalance(rejecting.client)).toMatch(wholeAmount(50));
    expect((await withdrawalRow(withdrawalId)).status).toBe('rejected');
  });
});

describe('agent tag, note and enhanced-KYC actions are replay-safe', () => {
  const vipReason = 'high lifetime deposits with steady play';
  let active: Awaited<ReturnType<typeof newPlayer>>;
  let excluded: Awaited<ReturnType<typeof newPlayer>>;

  beforeAll(async () => {
    active = await newPlayer('actions-active');
    excluded = await newPlayer('actions-excluded');
    const exclusion = await admin.post(`/compliance/players/${excluded.userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'player requested, permanent',
      confirm: true,
    });
    expect(exclusion.status).toBe(200);
  });

  it('refuses vip for a self-excluded player when evaluated and again when executed', async () => {
    const payload = { playerId: excluded.playerId, tagKey: 'vip', reason: vipReason };
    const proposalId = randomUUID();

    expect(await kernel.checkPrecondition('add_tag', payload, adminRun(adminId))).toEqual({
      ok: false,
      error: 'player_not_eligible',
    });
    expect(await kernel.executeAction('add_tag', payload, execution(proposalId))).toEqual({
      ok: false,
      error: 'player_not_eligible',
    });

    expect(await vipTagRows(excluded.playerId)).toHaveLength(0);
    const failed = await auditRowsOf('mcp.action.failed', proposalId);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.after).toMatchObject({
      actionTypeId: 'add_tag',
      error: 'player_not_eligible',
    });
  });

  it("forbids a player's user id acting as an admin the precondition, which would reveal the exclusion", async () => {
    const intruder = await newPlayer('precondition-intruder');
    const run = adminRun(intruder.userId);
    const payload = { playerId: excluded.playerId, tagKey: 'vip', reason: vipReason };

    expect(await kernel.checkPrecondition('add_tag', payload, run)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await auditRowsOfCall(run.correlationId)).toHaveLength(0);
    await vi.waitFor(
      async () => {
        const denials = await auditRowsOf('identity.user.unauthorized_access', 'tag:create');
        expect(denials).toContainEqual(
          expect.objectContaining({
            actorType: 'player',
            actorId: intruder.playerId,
            resourceType: 'tag',
            result: 'failure',
          }),
        );
      },
      { timeout: 15_000, interval: 100 },
    );
  });

  it('tags an active player vip once when the approved proposal is replayed', async () => {
    const payload = { playerId: active.playerId, tagKey: 'vip', reason: vipReason };
    const proposalId = randomUUID();

    expect(await kernel.checkPrecondition('add_tag', payload, adminRun(adminId))).toEqual({
      ok: true,
    });
    expect(await kernel.executeAction('add_tag', payload, execution(proposalId))).toEqual({
      ok: true,
      outcome: 'applied',
    });
    expect(await kernel.executeAction('add_tag', payload, execution(proposalId))).toEqual({
      ok: true,
      outcome: 'already_applied',
    });

    expect(await vipTagRows(active.playerId)).toEqual([
      { id: expect.any(String), removedAt: null },
    ]);
  });

  it('writes the proposed note once when the approved proposal is replayed', async () => {
    const payload = {
      playerId: active.playerId,
      content: 'Agent review: deposit pattern matches the declared source of funds.',
    };
    const proposalId = randomUUID();

    const first = await kernel.executeAction('add_note', payload, execution(proposalId));
    expect(first).toEqual({ ok: true, outcome: 'applied', detail: { noteId: expect.any(String) } });
    expect(await kernel.executeAction('add_note', payload, execution(proposalId))).toEqual({
      ok: true,
      outcome: 'already_applied',
    });

    const noteId = first.ok ? first.detail?.['noteId'] : undefined;
    expect(await noteIdsOf(active.playerId)).toEqual([noteId]);
    const created = await auditRowsOf('admin.player_note.created', active.playerId);
    expect(created).toHaveLength(1);
    expect(created[0]?.after).toMatchObject({ noteId, proposalId });
  });

  it('requests enhanced KYC once when the approved proposal is replayed, and kyc.status shows it', async () => {
    const reason = 'deposits crossed the enhanced due diligence threshold';
    const payload = { playerId: active.playerId, reason };
    const proposalId = randomUUID();

    expect(
      await kernel.checkPrecondition('request_enhanced_kyc', payload, adminRun(adminId)),
    ).toEqual({ ok: true });
    expect(
      await kernel.executeAction('request_enhanced_kyc', payload, execution(proposalId)),
    ).toEqual({ ok: true, outcome: 'applied' });
    expect(
      await kernel.executeAction('request_enhanced_kyc', payload, execution(proposalId)),
    ).toEqual({ ok: true, outcome: 'already_applied' });

    expect(await advancedKycRows(active.userId)).toEqual([
      { status: 'resubmission_requested', triggeredBy: 'manual' },
    ]);

    const output = outputOf(
      await kernel.invokeTool('kyc.status', { playerId: active.playerId }, adminRun(adminId)),
    );
    expect(Object.keys(output).sort()).toEqual(allowListOf('kyc.status'));
    expect(output).toMatchObject({
      playerId: active.playerId,
      advanced: { status: 'resubmission_requested', triggeredBy: 'manual' },
      advancedDecisionReason: reason,
    });

    expect(
      await kernel.checkPrecondition('request_enhanced_kyc', payload, adminRun(adminId)),
    ).toEqual({ ok: false, error: 'already_requested' });
  });
});

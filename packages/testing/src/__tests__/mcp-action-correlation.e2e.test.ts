import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { MCP_KERNEL, type McpKernel } from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
  bootE2e,
  closeE2e,
  flushAudit,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let kernel: McpKernel;
let adminId: string;

const SEEDED_ADMIN_EMAIL = 'admin@oss.dev';
const REASON = 'agent flagged the account for a closer look';

type Player = Awaited<ReturnType<typeof registerAndMaterializePlayer>>;

const drizzle = () => app.container.get(DRIZZLE).db;

async function auditRowsOf(correlationId: string) {
  await flushAudit(app);
  return drizzle()
    .select({
      action: auditLog.action,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
    })
    .from(auditLog)
    .where(eq(auditLog.correlationId, correlationId))
    .orderBy(asc(auditLog.seq));
}

async function newPlayer(label: string): Promise<Player> {
  return registerAndMaterializePlayer(app, { email: `mcp-corr-${label}-${randomUUID()}@e2e.test` });
}

async function pendingWithdrawal(client: TestClient): Promise<string> {
  const deposit = await client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount: '50',
    currency: 'USD',
  });
  expect(deposit.status).toBe(200);
  const res = await client.post('/wallet/withdraw', {
    idempotencyKey: randomUUID(),
    amount: '20',
    currency: 'USD',
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; transactionId: string };
  expect(body.status).toBe('pending');
  return body.transactionId;
}

beforeAll(async () => {
  ({ db, app } = await bootE2e());
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
  await closeE2e({ app, db });
});

// Each case names the row the module writes for the state it changed: written in the action's
// own transaction, or (request_enhanced_kyc) by the audit subscriber from an outbox event.
const cases: {
  actionTypeId: string;
  payload: (player: Player) => Promise<Record<string, unknown>>;
  moduleRow: string;
}[] = [
  {
    actionTypeId: 'add_note',
    payload: async (player) => ({ playerId: player.playerId, content: 'Agent review note.' }),
    moduleRow: 'admin.player_note.created',
  },
  {
    actionTypeId: 'add_tag',
    payload: async (player) => ({ playerId: player.playerId, tagKey: 'vip', reason: REASON }),
    moduleRow: 'tag.player.assigned',
  },
  {
    actionTypeId: 'send_to_manual_review',
    payload: async (player) => ({ playerId: player.playerId, reason: REASON }),
    moduleRow: 'tag.player.assigned',
  },
  {
    actionTypeId: 'request_enhanced_kyc',
    payload: async (player) => ({ playerId: player.playerId, reason: REASON }),
    moduleRow: 'compliance.kyc.updated',
  },
  {
    actionTypeId: 'hold_withdrawal',
    payload: async (player) => ({
      playerId: player.playerId,
      withdrawalId: await pendingWithdrawal(player.client),
      reason: REASON,
    }),
    moduleRow: 'wallet.withdrawal.held',
  },
];

describe('every audit row of one executed proposal carries its correlation id', () => {
  it.each(cases)(
    '$actionTypeId: the module row $moduleRow shares the kernel row correlation id',
    async ({ actionTypeId, payload, moduleRow }) => {
      const player = await newPlayer(actionTypeId);
      const proposalId = randomUUID();
      const correlationId = `mcp-corr-${randomUUID()}`;

      const result = await kernel.executeAction(actionTypeId, await payload(player), {
        proposalId,
        actor: { kind: 'admin', adminId },
        correlationId,
      });
      expect(result).toMatchObject({ ok: true, outcome: 'applied' });

      await vi.waitFor(
        async () => {
          expect(await auditRowsOf(correlationId)).toEqual(
            expect.arrayContaining([
              { action: moduleRow, resourceType: 'player', resourceId: player.playerId },
              {
                action: 'mcp.action.executed',
                resourceType: 'agent-proposal',
                resourceId: proposalId,
              },
            ]),
          );
        },
        { timeout: 15_000, interval: 100 },
      );
    },
  );

  it('leaves a refused execution with only the kernel row, and no row of another run', async () => {
    const correlationId = `mcp-corr-${randomUUID()}`;
    const proposalId = randomUUID();

    const result = await kernel.executeAction(
      'add_note',
      { playerId: randomUUID(), content: 'Agent review note.' },
      { proposalId, actor: { kind: 'admin', adminId }, correlationId },
    );
    expect(result).toEqual({ ok: false, error: 'player_not_found' });
    expect(await auditRowsOf(correlationId)).toEqual([
      { action: 'mcp.action.failed', resourceType: 'agent-proposal', resourceId: proposalId },
    ]);
  });
});

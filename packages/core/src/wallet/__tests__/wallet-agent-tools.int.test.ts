import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  IDENTITY_READER,
  RATE_LIMITER,
  type AdminUserDirectory,
  type IdentityReader,
  type RateLimiterAdapter,
  type RunContext,
} from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeAuditWriter, makeEventBus, makeIdentityReader, mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';
import { OPEN_WITHDRAWALS_LIMIT } from '../contract/index.js';
import walletPlugin from '../plugin.js';

let db: TestDb;

const HOLD_REASON = 'pattern matches a mule account';

type Player = { playerId: string; userId: string; walletId: string };

function bootKernel(identity: IdentityReader = playerDirectory()) {
  const container = new Container<CoreTokenCatalog>();
  const domainAudit = makeAuditWriter();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => makeEventBus());
  container.register(AUDIT_WRITER, () => domainAudit);
  container.register(IDENTITY_READER, () => identity);
  container.register(ADMIN_USER_DIRECTORY, () => mock<AdminUserDirectory>({}));
  container.register(RATE_LIMITER, () => mock<RateLimiterAdapter<string>>({}));
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('wallet');
  walletPlugin.register(registry);
  const kernel = createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
  return { kernel, domainAudit };
}

const players = new Map<string, string>();

function playerDirectory(): IdentityReader {
  return {
    ...makeIdentityReader(),
    getUserIdByPlayerId: vi.fn(async (playerId: string) => players.get(playerId) ?? null),
  };
}

const adminId = randomUUID();

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: adminId },
  catalogVersion: 'test',
  correlationId: 'wallet-agent-tools',
});

const execution = (proposalId: string = randomUUID()) => ({
  proposalId,
  actor: runContext().actor,
  correlationId: 'wallet-agent-tools',
});

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  players.clear();
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

async function seedPlayer(balance = '100'): Promise<Player> {
  const playerId = randomUUID();
  const record = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seedPlayer: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: record.id, currency: 'USD', amount: balance });
  players.set(playerId, record.userId);
  return { playerId, userId: record.userId, walletId: record.id };
}

async function seedTx(
  walletId: string,
  values: Pick<typeof walletTransaction.$inferInsert, 'type' | 'amount'> &
    Partial<typeof walletTransaction.$inferInsert>,
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({ walletId, currency: 'USD', status: 'completed', ...values })
      .returning(),
    new Error('seedTx: query returned no row'),
  );
}

async function statusOf(id: string) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .select({ status: walletTransaction.status })
      .from(walletTransaction)
      .where(eq(walletTransaction.id, id)),
    new Error('statusOf: query returned no row'),
  );
  return row.status;
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe('wallet.activity through the MCP kernel (real PG)', () => {
  it('reports balances, completed totals inside the window per currency, and open withdrawals', async () => {
    const { kernel } = bootKernel();
    const player = await seedPlayer();
    const stranger = await seedPlayer();
    await seedTx(player.walletId, { type: 'deposit', amount: '50' });
    await seedTx(player.walletId, { type: 'deposit', amount: '25' });
    await seedTx(player.walletId, { type: 'deposit', amount: '99', status: 'pending' });
    await seedTx(player.walletId, { type: 'deposit', amount: '500', createdAt: daysAgo(40) });
    await seedTx(player.walletId, { type: 'deposit', amount: '0.5', currency: 'BTC' });
    await seedTx(player.walletId, { type: 'withdrawal', amount: '30' });
    await seedTx(player.walletId, { type: 'bet', amount: '10' });
    await seedTx(player.walletId, { type: 'bet', amount: '5' });
    await seedTx(player.walletId, { type: 'win', amount: '7' });
    const pending = await seedTx(player.walletId, {
      type: 'withdrawal',
      amount: '20',
      status: 'pending',
      createdAt: daysAgo(2),
    });
    const held = await seedTx(player.walletId, {
      type: 'withdrawal',
      amount: '15',
      status: 'on_hold',
      createdAt: daysAgo(1),
    });
    await seedTx(player.walletId, { type: 'withdrawal', amount: '11', status: 'processing' });
    await seedTx(stranger.walletId, { type: 'withdrawal', amount: '9', status: 'pending' });

    const result = await kernel.invokeTool(
      'wallet.activity',
      { playerId: player.playerId, windowDays: '30' },
      runContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        playerId: player.playerId,
        windowDays: 30,
        activeCurrency: 'USD',
        balances: [{ currency: 'USD', balance: '100.000000000000000000' }],
        totals: [
          {
            currency: 'BTC',
            deposits: '0.500000000000000000',
            depositCount: 1,
            withdrawals: '0',
            withdrawalCount: 0,
            bets: '0',
            wins: '0',
          },
          {
            currency: 'USD',
            deposits: '75.000000000000000000',
            depositCount: 2,
            withdrawals: '30.000000000000000000',
            withdrawalCount: 1,
            bets: '15.000000000000000000',
            wins: '7.000000000000000000',
          },
        ],
        openWithdrawals: [
          {
            withdrawalId: held.id,
            amount: '15.000000000000000000',
            currency: 'USD',
            status: 'on_hold',
            requestedAt: held.createdAt.toISOString(),
          },
          {
            withdrawalId: pending.id,
            amount: '20.000000000000000000',
            currency: 'USD',
            status: 'pending',
            requestedAt: pending.createdAt.toISOString(),
          },
        ],
      },
    });
  });

  it('lists at most the newest open withdrawals', async () => {
    const { kernel } = bootKernel();
    const player = await seedPlayer();
    for (let day = 1; day <= OPEN_WITHDRAWALS_LIMIT + 1; day += 1) {
      await seedTx(player.walletId, {
        type: 'withdrawal',
        amount: '1',
        status: 'pending',
        createdAt: daysAgo(day),
      });
    }

    const result = await kernel.invokeTool(
      'wallet.activity',
      { playerId: player.playerId },
      runContext(),
    );

    const open = result.ok ? result.output['openWithdrawals'] : null;
    expect(Array.isArray(open) && open.length).toBe(OPEN_WITHDRAWALS_LIMIT);
  });

  it('reads a player without a wallet as having no activity', async () => {
    const { kernel } = bootKernel();
    const playerId = randomUUID();
    players.set(playerId, randomUUID());

    const result = await kernel.invokeTool('wallet.activity', { playerId }, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        playerId,
        windowDays: 30,
        activeCurrency: 'USD',
        balances: [],
        totals: [],
        openWithdrawals: [],
      },
    });
  });

  it('answers player_not_found for an unknown player', async () => {
    const { kernel } = bootKernel();

    const result = await kernel.invokeTool(
      'wallet.activity',
      { playerId: randomUUID() },
      runContext(),
    );

    expect(result).toEqual({ ok: false, error: 'player_not_found' });
  });

  it('refuses a window outside 1..365 days', async () => {
    const { kernel } = bootKernel();
    const player = await seedPlayer();

    const result = await kernel.invokeTool(
      'wallet.activity',
      { playerId: player.playerId, windowDays: 366 },
      runContext(),
    );

    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});

describe('hold_withdrawal through the MCP kernel (real PG)', () => {
  const pendingWithdrawal = (walletId: string) =>
    seedTx(walletId, { type: 'withdrawal', amount: '40', status: 'pending' });

  it('passes the precondition for a pending withdrawal of the named player', async () => {
    const { kernel } = bootKernel();
    const player = await seedPlayer();
    const withdrawal = await pendingWithdrawal(player.walletId);

    const result = await kernel.checkPrecondition(
      'hold_withdrawal',
      { playerId: player.playerId, withdrawalId: withdrawal.id, reason: HOLD_REASON },
      runContext(),
    );

    expect(result).toEqual({ ok: true });
  });

  it('refuses the precondition with the code for each unholdable case', async () => {
    const { kernel } = bootKernel();
    const player = await seedPlayer();
    const stranger = await seedPlayer();
    const processing = await seedTx(player.walletId, {
      type: 'withdrawal',
      amount: '40',
      status: 'processing',
    });
    const deposit = await seedTx(player.walletId, { type: 'deposit', amount: '40' });
    const strangers = await pendingWithdrawal(stranger.walletId);
    const precondition = (playerId: string, withdrawalId: string) =>
      kernel.checkPrecondition(
        'hold_withdrawal',
        { playerId, withdrawalId, reason: HOLD_REASON },
        runContext(),
      );

    expect(await precondition(randomUUID(), strangers.id)).toEqual({
      ok: false,
      error: 'player_not_found',
    });
    expect(await precondition(player.playerId, strangers.id)).toEqual({
      ok: false,
      error: 'withdrawal_not_found',
    });
    expect(await precondition(player.playerId, deposit.id)).toEqual({
      ok: false,
      error: 'withdrawal_not_found',
    });
    expect(await precondition(player.playerId, processing.id)).toEqual({
      ok: false,
      error: 'withdrawal_not_pending',
    });
  });

  it('holds once per proposal: a replay resolves already_applied with one audit record', async () => {
    const { kernel, domainAudit } = bootKernel();
    const player = await seedPlayer();
    const withdrawal = await pendingWithdrawal(player.walletId);
    const payload = { playerId: player.playerId, withdrawalId: withdrawal.id, reason: HOLD_REASON };
    const proposal = execution();

    const first = await kernel.executeAction('hold_withdrawal', payload, proposal);
    const replay = await kernel.executeAction('hold_withdrawal', payload, proposal);

    expect(first).toEqual({ ok: true, outcome: 'applied' });
    expect(replay).toEqual({ ok: true, outcome: 'already_applied' });
    expect(await statusOf(withdrawal.id)).toBe('on_hold');
    expect(domainAudit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(domainAudit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: adminId,
        action: 'wallet.withdrawal.held',
        resourceId: withdrawal.id,
        after: {
          userId: player.userId,
          transactionId: withdrawal.id,
          status: 'on_hold',
          reason: HOLD_REASON,
          proposalId: proposal.proposalId,
        },
      }),
    );
  });

  it("answers withdrawal_not_found for another player's withdrawal and leaves it pending", async () => {
    const { kernel } = bootKernel();
    const player = await seedPlayer();
    const stranger = await seedPlayer();
    const strangers = await pendingWithdrawal(stranger.walletId);

    const result = await kernel.executeAction(
      'hold_withdrawal',
      { playerId: player.playerId, withdrawalId: strangers.id, reason: HOLD_REASON },
      execution(),
    );

    expect(result).toEqual({ ok: false, error: 'withdrawal_not_found' });
    expect(await statusOf(strangers.id)).toBe('pending');
  });

  it('answers withdrawal_not_pending once the withdrawal was decided', async () => {
    const { kernel } = bootKernel();
    const player = await seedPlayer();
    const completed = await seedTx(player.walletId, { type: 'withdrawal', amount: '40' });

    const result = await kernel.executeAction(
      'hold_withdrawal',
      { playerId: player.playerId, withdrawalId: completed.id, reason: HOLD_REASON },
      execution(),
    );

    expect(result).toEqual({ ok: false, error: 'withdrawal_not_pending' });
    expect(await statusOf(completed.id)).toBe('completed');
  });

  it('fails closed when the bound identity reader cannot resolve a player id', async () => {
    const { kernel } = bootKernel(makeIdentityReader());
    const player = await seedPlayer();
    const withdrawal = await pendingWithdrawal(player.walletId);

    const result = await kernel.executeAction(
      'hold_withdrawal',
      { playerId: player.playerId, withdrawalId: withdrawal.id, reason: HOLD_REASON },
      execution(),
    );

    expect(result).toEqual({ ok: false, error: 'internal_error' });
    expect(await statusOf(withdrawal.id)).toBe('pending');
  });

  it('refuses a blank reason before anything runs', async () => {
    const { kernel } = bootKernel();
    const player = await seedPlayer();
    const withdrawal = await pendingWithdrawal(player.walletId);

    const result = await kernel.executeAction(
      'hold_withdrawal',
      { playerId: player.playerId, withdrawalId: withdrawal.id, reason: '   ' },
      execution(),
    );

    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await statusOf(withdrawal.id)).toBe('pending');
  });
});

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import type { RunContext } from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeAuditWriter } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction } from '../schema/index.js';
import walletPlugin from '../plugin.js';

let db: TestDb;

const RANGE = { from: '2026-01-01', to: '2026-01-31' };
const AT = (iso: string) => new Date(iso);
const amount = (value: number) => expect.stringMatching(new RegExp(`^${value}(\\.0+)?$`));
const REVIEW_NOTE = 'SAR filed: structuring across linked accounts';
const PAYOUT_ADDRESS = 'bc1qtransactionsfinddestination00000000';
const PAYOUT_HASH = '0xfeedfacecafebeef';
const PROVIDER_REF = 'psp-charge-123456';

// Only transactions.find: the wallet's other tools need identity, segment and rate ports.
function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('wallet');
  walletPlugin.register(registry);
  return createMcpKernel({
    tools: registry.mcp.getTools().filter((tool) => tool.contract.id === 'transactions.find'),
    actions: [],
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
}

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: randomUUID() },
  catalogVersion: 'test',
  correlationId: 'transactions-find-tool',
});

async function seedPlayer() {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(player).values({ userId: randomUUID() }).returning(),
    new Error('seedPlayer: no row'),
  );
  const owned = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: row.userId }).returning(),
    new Error('seedPlayer: no wallet'),
  );
  return { ...row, walletId: owned.id };
}

async function seedTransaction(
  walletId: string,
  values: Partial<typeof walletTransaction.$inferInsert> & { createdAt: Date },
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId,
        type: 'deposit',
        amount: '100',
        currency: 'USD',
        status: 'completed',
        ...values,
      })
      .returning(),
    new Error('seedTransaction: no row'),
  );
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('transactions.find through the MCP kernel (real PG)', () => {
  it('lists the transactions of the range by player id, newest first, without addresses or notes', async () => {
    const kernel = bootKernel();
    const [alice, bob] = [await seedPlayer(), await seedPlayer()];
    const deposit = await seedTransaction(alice.walletId, {
      rail: 'fiat',
      providerName: 'psp',
      providerRefId: PROVIDER_REF,
      createdAt: AT('2026-01-10T10:00:00.000Z'),
    });
    // The last instant of `to` counts; the first of the next day does not.
    const withdrawal = await seedTransaction(bob.walletId, {
      type: 'withdrawal',
      amount: '6000.5',
      status: 'on_hold',
      rail: 'crypto',
      reviewReason: REVIEW_NOTE,
      destinationAddress: PAYOUT_ADDRESS,
      txHash: PAYOUT_HASH,
      createdAt: AT('2026-01-31T23:59:59.999Z'),
    });
    await seedTransaction(bob.walletId, { createdAt: AT('2026-02-01T00:00:00.000Z') });
    // A wallet whose player has no profile row is still listed, by no player.
    const orphanWallet = findOneOrThrow(
      await db.drizzle.db.insert(wallet).values({ userId: randomUUID() }).returning(),
      new Error('no orphan wallet'),
    );
    const bet = await seedTransaction(orphanWallet.id, {
      type: 'bet',
      amount: '5',
      createdAt: AT('2026-01-05T10:00:00.000Z'),
    });

    const result = await kernel.invokeTool('transactions.find', RANGE, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        ...RANGE,
        total: 3,
        truncated: false,
        transactions: [
          {
            transactionId: withdrawal.id,
            playerId: bob.id,
            type: 'withdrawal',
            status: 'on_hold',
            amount: '6000.500000000000000000',
            currency: 'USD',
            rail: 'crypto',
            createdAt: '2026-01-31T23:59:59.999Z',
          },
          {
            transactionId: deposit.id,
            playerId: alice.id,
            type: 'deposit',
            status: 'completed',
            amount: amount(100),
            currency: 'USD',
            rail: 'fiat',
            createdAt: '2026-01-10T10:00:00.000Z',
          },
          expect.objectContaining({ transactionId: bet.id, playerId: null, rail: null }),
        ],
      },
    });
    const served = JSON.stringify(result);
    for (const hidden of [
      REVIEW_NOTE,
      PAYOUT_ADDRESS,
      PAYOUT_HASH,
      PROVIDER_REF,
      alice.userId,
      bob.userId,
    ]) {
      expect(served).not.toContain(hidden);
    }
  });

  it('filters by player, type, status, currency and amount, sorts by amount, and counts past the limit', async () => {
    const kernel = bootKernel();
    const [alice, bob] = [await seedPlayer(), await seedPlayer()];
    const at = AT('2026-01-15T10:00:00.000Z');
    const [, large, middle] = await Promise.all(
      ['500', '2000', '900'].map((value) =>
        seedTransaction(alice.walletId, { amount: value, createdAt: at }),
      ),
    );
    await seedTransaction(alice.walletId, { amount: '499.99', createdAt: at });
    await seedTransaction(alice.walletId, { amount: '5000', status: 'failed', createdAt: at });
    await seedTransaction(alice.walletId, { amount: '5000', type: 'withdrawal', createdAt: at });
    await seedTransaction(alice.walletId, { amount: '5000', currency: 'EUR', createdAt: at });
    await seedTransaction(bob.walletId, { amount: '5000', createdAt: at });

    const result = await kernel.invokeTool(
      'transactions.find',
      {
        ...RANGE,
        playerId: alice.id,
        type: ['deposit'],
        status: ['completed', 'pending'],
        currency: 'usd',
        minAmount: '500',
        sortBy: 'amount',
        sortDir: 'desc',
        limit: 2,
      },
      runContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        total: 3,
        truncated: true,
        transactions: [{ transactionId: large.id }, { transactionId: middle.id }],
      },
    });
  });

  it('refuses a range over 92 days and a limit over 50', async () => {
    const kernel = bootKernel();

    for (const input of [
      { from: '2026-01-01', to: '2026-04-03' },
      { from: '2026-02-01', to: '2026-01-31' },
      { limit: 51 },
      { minAmount: '-5' },
    ]) {
      expect(await kernel.invokeTool('transactions.find', input, runContext())).toMatchObject({
        ok: false,
        error: 'invalid_input',
      });
    }
  });
});

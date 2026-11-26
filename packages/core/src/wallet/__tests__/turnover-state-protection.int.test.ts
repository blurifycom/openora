import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction } from '../schema/index.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

async function seedStake(overrides: Partial<typeof walletTransaction.$inferInsert> = {}) {
  const w = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seed: no wallet'),
  );
  return findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId: w.id,
        type: 'bet',
        amount: '10',
        currency: 'USD',
        status: 'completed',
        rail: 'fiat',
        ...overrides,
      })
      .returning(),
    new Error('seed: no ledger row'),
  );
}

const setState = (id: string, turnoverState: 'deferred' | 'counted' | 'reversal' | null) =>
  db.drizzle.db
    .update(walletTransaction)
    .set({ turnoverState })
    .where(eq(walletTransaction.id, id));

const stateOf = async (id: string) =>
  findOneOrThrow(
    await db.drizzle.db
      .select({ state: walletTransaction.turnoverState })
      .from(walletTransaction)
      .where(eq(walletTransaction.id, id)),
    new Error('stake missing'),
  ).state;

const appendOnlyRejection = async (query: PromiseLike<unknown>) => {
  const error = await Promise.resolve(query).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error & { cause?: Error }).cause?.message).toMatch(/append-only/);
};

const deferredStake = () => seedStake({ turnoverContribution: '10', turnoverState: 'deferred' });

describe('wallet_transaction turnover state protection (real PG)', () => {
  it('lets a stake with no state take its first state, then freezes it', async () => {
    const stake = await seedStake();

    await setState(stake.id, 'reversal');

    expect(await stateOf(stake.id)).toBe('reversal');
    await appendOnlyRejection(setState(stake.id, 'counted'));
    expect(await stateOf(stake.id)).toBe('reversal');
  });

  it('moves a deferred stake to counted exactly once', async () => {
    const stake = await deferredStake();

    await setState(stake.id, 'counted');

    expect(await stateOf(stake.id)).toBe('counted');
    await appendOnlyRejection(setState(stake.id, 'deferred'));
    await appendOnlyRejection(setState(stake.id, null));
    expect(await stateOf(stake.id)).toBe('counted');
  });

  it('never clears a deferred stake', async () => {
    const deferred = await deferredStake();

    await appendOnlyRejection(setState(deferred.id, null));

    expect(await stateOf(deferred.id)).toBe('deferred');
  });
});

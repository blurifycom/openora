import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { game, gameProvider, gameRound } from '../schema/index.js';

let db: TestDb;
let gameId: string;

beforeAll(async () => {
  db = await createTestDb([migrate]);
  const provider = findOneOrThrow(
    await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `studio-${randomUUID()}`, name: 'Studio' })
      .returning(),
    new Error('seed: no provider'),
  );
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({
        name: 'Game',
        slug: `game-${randomUUID()}`,
        providerId: provider.id,
        aggregator: 'agg',
      })
      .returning(),
    new Error('seed: no game'),
  );
  gameId = row.id;
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${gameRound}`);
});

async function seedRound() {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(gameRound)
      .values({ gameId, userId: randomUUID(), currency: 'USD', betAmount: '5' })
      .returning(),
    new Error('seed: no round'),
  );
}

const rejectedWith = async (query: PromiseLike<unknown>, message: RegExp) => {
  const error = await Promise.resolve(query).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error & { cause?: Error }).cause?.message).toMatch(message);
};

const update = (id: string, set: Partial<typeof gameRound.$inferInsert>) =>
  db.drizzle.db.update(gameRound).set(set).where(eq(gameRound.id, id));

describe('game_round record protection (real PG)', () => {
  it('rejects removing a round', async () => {
    const round = await seedRound();

    await rejectedWith(
      db.drizzle.db.delete(gameRound).where(eq(gameRound.id, round.id)),
      /append-only/,
    );
    expect(await db.drizzle.db.select().from(gameRound)).toHaveLength(1);
  });

  it.each([
    ['player', { userId: randomUUID() }],
    ['game', { gameId: randomUUID() }],
    ['currency', { currency: 'EUR' }],
    ['start time', { startedAt: new Date('2001-01-01') }],
    ['external round id', { externalRoundId: 'rewritten' }],
  ])('rejects rewriting the %s of a round', async (_name, set) => {
    const round = await seedRound();

    await rejectedWith(update(round.id, set), /append-only/);
  });

  it('lets settlement update status, stake, win and end time', async () => {
    const round = await seedRound();

    await update(round.id, {
      status: 'completed',
      betAmount: '10',
      winAmount: '25',
      endedAt: new Date(),
    });

    const [after] = await db.drizzle.db.select().from(gameRound).where(eq(gameRound.id, round.id));
    expect(after?.status).toBe('completed');
    expect(Number(after?.winAmount)).toBe(25);
  });

  it('passes an update that matches no round', async () => {
    await expect(update(randomUUID(), { gameId: randomUUID() })).resolves.toBeDefined();
  });
});

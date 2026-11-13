import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameProvider, ledgerGame } from '../schema/index.js';
import { applyLedgerGames, emitLedgerGames } from '../service/ledger-game.service.js';
import { backfillLedgerGames } from '../seed/index.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${ledgerGame}, ${game}, ${gameProvider} CASCADE`);
});

async function seedProvider() {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `studio-${randomUUID()}`, name: 'Studio' })
      .returning(),
    new Error('seed: no provider'),
  );
}

async function seedGame(providerId: string) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({ name: 'Game', slug: `game-${randomUUID()}`, providerId, aggregator: 'agg' })
      .returning(),
    new Error('seed: no game'),
  );
}

async function projected(gameId: string) {
  return db.drizzle.db.select().from(ledgerGame).where(eq(ledgerGame.gameId, gameId));
}

describe('game ledger_version trigger (real PG)', () => {
  it('moves only when a projected column changes, and cannot be set by hand', async () => {
    const provider = await seedProvider();
    const other = await seedProvider();
    const created = await seedGame(provider.id);
    expect(created.ledgerVersion).toBe(0);

    const [renamed] = await db.drizzle.db
      .update(game)
      .set({ name: 'Renamed', ledgerVersion: 41 })
      .where(eq(game.id, created.id))
      .returning();
    expect(renamed?.ledgerVersion).toBe(0);

    const [moved] = await db.drizzle.db
      .update(game)
      .set({ providerId: other.id })
      .where(eq(game.id, created.id))
      .returning();
    const [retyped] = await db.drizzle.db
      .update(game)
      .set({ gameType: 'original' })
      .where(eq(game.id, created.id))
      .returning();
    expect(moved?.ledgerVersion).toBe(1);
    expect(retyped?.ledgerVersion).toBe(2);
  });
});

describe('ledger_game projection (real PG)', () => {
  it('treats a redelivered event as a no-op and never lets an older one overwrite a newer one', async () => {
    const gameId = randomUUID();
    const older = { gameId, providerId: randomUUID(), gameType: 'casino' as const, version: 1 };
    const newer = { gameId, providerId: randomUUID(), gameType: 'original' as const, version: 2 };

    await applyLedgerGames(db.drizzle.db, [newer]);
    const [first] = await projected(gameId);
    await applyLedgerGames(db.drizzle.db, [newer]);
    await applyLedgerGames(db.drizzle.db, [older]);

    const rows = await projected(gameId);
    expect(rows).toEqual([first]);
    expect(rows[0]).toMatchObject({
      providerId: newer.providerId,
      gameType: 'original',
      version: 2,
    });
  });

  it('applies a newer snapshot over an older one', async () => {
    const gameId = randomUUID();
    await applyLedgerGames(db.drizzle.db, [
      { gameId, providerId: randomUUID(), gameType: 'casino', version: 0 },
    ]);
    const providerId = randomUUID();
    await applyLedgerGames(db.drizzle.db, [{ gameId, providerId, gameType: 'casino', version: 1 }]);

    expect(await projected(gameId)).toEqual([expect.objectContaining({ providerId, version: 1 })]);
  });

  it('writes the committed catalogue state to the outbox in the caller transaction', async () => {
    const provider = await seedProvider();
    const created = await seedGame(provider.id);
    const events = makeEventBus();

    await db.drizzle.db.transaction((tx) =>
      emitLedgerGames(tx, events, [created.id, created.id, randomUUID()]),
    );

    expect(events.emitInTransaction).toHaveBeenCalledTimes(1);
    expect(events.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'gaming.game.changed',
      {
        games: [{ gameId: created.id, providerId: provider.id, gameType: 'casino', version: 0 }],
      },
    );
  });
});

describe('backfillLedgerGames (real PG)', () => {
  it('projects every game, converges on a re-run, and keeps a newer projected row', async () => {
    const provider = await seedProvider();
    const first = await seedGame(provider.id);
    const second = await seedGame(provider.id);
    const ahead = { gameId: second.id, providerId: randomUUID(), gameType: 'casino' as const };
    await applyLedgerGames(db.drizzle.db, [{ ...ahead, version: 5 }]);

    await backfillLedgerGames(db.drizzle.db);
    const once = await db.drizzle.db.select().from(ledgerGame).orderBy(ledgerGame.gameId);
    await backfillLedgerGames(db.drizzle.db);
    const twice = await db.drizzle.db.select().from(ledgerGame).orderBy(ledgerGame.gameId);

    expect(twice).toEqual(once);
    expect(once).toHaveLength(2);
    expect(await projected(first.id)).toEqual([
      expect.objectContaining({ providerId: provider.id, gameType: 'casino', version: 0 }),
    ]);
    expect(await projected(second.id)).toEqual([expect.objectContaining({ ...ahead, version: 5 })]);
  });
});

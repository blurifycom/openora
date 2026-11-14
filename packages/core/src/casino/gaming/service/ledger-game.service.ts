// The round ledger's view of the catalogue: `ledger_game`, fed by `gaming.ledger_game.projected`.
// Round code reads this table, never `game`, so the ledger stops depending on the catalogue
// schema. Every write keeps the highest `version`, so a redelivered or reordered event, and a
// re-run backfill, leave a newer row as it is.
import {
  withAdvisoryXactLock,
  type DrizzleDb,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import {
  GamingUnknownGameError,
  type DomainEventPayload,
  type GamingRoundWager,
} from '@openora/core/contracts';
import { eq, inArray, sql } from 'drizzle-orm';
import { GAMES_CHANGED_EVENT_BATCH } from '../contract/index.js';
import { game, ledgerGame, type Game } from '../schema/index.js';

type LedgerGameSnapshot = DomainEventPayload<'gaming.ledger_game.projected'>['games'][number];

const BACKFILL_LOCK_KEY = 'gaming:ledger_game:backfill';

const keepNewest = {
  target: ledgerGame.gameId,
  set: {
    providerId: sql`excluded.provider_id`,
    gameType: sql`excluded.game_type`,
    wagerProduct: sql`excluded.wager_product`,
    rtp: sql`excluded.rtp`,
    version: sql`excluded.version`,
    updatedAt: sql`now()`,
  },
  setWhere: sql`${ledgerGame.version} < excluded.version`,
};

/** The wagering inputs `ledger_game` holds for `gameId`, or undefined for a game it lacks. */
export async function readLedgerGame(
  db: DrizzleDb | DrizzleTx,
  gameId: Game['id'],
): Promise<GamingRoundWager | undefined> {
  const [row] = await db
    .select({ product: ledgerGame.wagerProduct, rtp: ledgerGame.rtp })
    .from(ledgerGame)
    .where(eq(ledgerGame.gameId, gameId))
    .limit(1);
  return row;
}

export async function assertLedgerGame(
  db: DrizzleDb | DrizzleTx,
  gameId: Game['id'],
): Promise<GamingRoundWager> {
  const row = await readLedgerGame(db, gameId);
  if (!row) {
    throw new GamingUnknownGameError(gameId);
  }
  return row;
}

export async function applyLedgerGames(
  db: DrizzleDb,
  games: readonly LedgerGameSnapshot[],
): Promise<void> {
  await db
    .insert(ledgerGame)
    .values([...games])
    .onConflictDoUpdate(keepNewest);
}

/** Writes the committed state of `gameIds` to the outbox on `tx`; unknown ids are dropped. */
export async function emitLedgerGames(
  tx: DrizzleTx,
  events: EventBus,
  gameIds: readonly Game['id'][],
): Promise<void> {
  const uniqueIds = [...new Set(gameIds)];
  for (let start = 0; start < uniqueIds.length; start += GAMES_CHANGED_EVENT_BATCH) {
    const games = await tx
      .select({
        gameId: game.id,
        providerId: game.providerId,
        gameType: game.gameType,
        wagerProduct: game.wagerProduct,
        rtp: game.rtp,
        version: game.ledgerVersion,
      })
      .from(game)
      .where(inArray(game.id, uniqueIds.slice(start, start + GAMES_CHANGED_EVENT_BATCH)));
    if (games.length > 0) {
      await events.emitInTransaction(tx, 'gaming.ledger_game.projected', { games });
    }
  }
}

/**
 * Projects every catalogue game into `ledger_game` and returns how many rows it wrote.
 * Convergent: it seeds a fresh ledger and heals a projection that missed an event.
 */
export async function backfillLedgerGames(db: DrizzleDb | DrizzleTx): Promise<number> {
  const result = await db
    .insert(ledgerGame)
    .select(
      db
        .select({
          gameId: game.id,
          providerId: game.providerId,
          gameType: game.gameType,
          wagerProduct: game.wagerProduct,
          rtp: game.rtp,
          version: game.ledgerVersion,
          updatedAt: sql`now()`.as('updated_at'),
        })
        .from(game),
    )
    .onConflictDoUpdate(keepNewest);
  return result.rowCount ?? 0;
}

/** The boot run of `backfillLedgerGames`: replicas booting together take turns, not race. */
export function backfillLedgerGamesAtBoot(db: DrizzleDb): Promise<number> {
  return db.transaction((tx) =>
    withAdvisoryXactLock(tx, BACKFILL_LOCK_KEY, () => backfillLedgerGames(tx)),
  );
}

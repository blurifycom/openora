// The round ledger's view of the catalogue: `ledger_game`, fed by `gaming.game.changed`.
// Round code reads this table, never `game`, so the ledger stops depending on the catalogue
// schema. Every write keeps the highest `version`, so a redelivered or reordered event, and a
// re-run backfill, leave a newer row as it is.
import type { DrizzleDb, DrizzleTx, EventBus } from '@openora/core/server';
import { GamingUnknownGameError, type DomainEventPayload } from '@openora/core/contracts';
import { eq, inArray, sql } from 'drizzle-orm';
import { GAMES_CHANGED_EVENT_BATCH } from '../contract/index.js';
import { game, ledgerGame, type Game } from '../schema/index.js';

type LedgerGameSnapshot = DomainEventPayload<'gaming.game.changed'>['games'][number];

const keepNewest = {
  target: ledgerGame.gameId,
  set: {
    providerId: sql`excluded.provider_id`,
    gameType: sql`excluded.game_type`,
    version: sql`excluded.version`,
    updatedAt: sql`now()`,
  },
  setWhere: sql`${ledgerGame.version} < excluded.version`,
};

export async function assertLedgerGame(
  db: DrizzleDb | DrizzleTx,
  gameId: Game['id'],
): Promise<void> {
  const [row] = await db
    .select({ gameId: ledgerGame.gameId })
    .from(ledgerGame)
    .where(eq(ledgerGame.gameId, gameId))
    .limit(1);
  if (!row) {
    throw new GamingUnknownGameError(gameId);
  }
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
        version: game.ledgerVersion,
      })
      .from(game)
      .where(inArray(game.id, uniqueIds.slice(start, start + GAMES_CHANGED_EVENT_BATCH)));
    if (games.length > 0) {
      await events.emitInTransaction(tx, 'gaming.game.changed', { games });
    }
  }
}

/**
 * Projects every catalogue game into `ledger_game`. Convergent, so it runs after every
 * migrate: it seeds a fresh ledger and heals a projection that missed an event.
 */
export async function backfillLedgerGames(db: DrizzleDb): Promise<void> {
  await db
    .insert(ledgerGame)
    .select(
      db
        .select({
          gameId: game.id,
          providerId: game.providerId,
          gameType: game.gameType,
          version: game.ledgerVersion,
          updatedAt: sql`now()`.as('updated_at'),
        })
        .from(game),
    )
    .onConflictDoUpdate(keepNewest);
}

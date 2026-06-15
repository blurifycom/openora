import { type EventBus, makeNotFoundError, getCurrentTenantId } from '@oss/core';
import { DrizzleService, findOneOrThrow } from '@oss/db';
import { eq, and, asc, desc } from 'drizzle-orm';
import { type GameAdapter } from '@oss/adapters';
import { DEFAULT_TENANT_ID } from '@oss/shared-schemas';
import { game, gameRound } from '../schema/index.js';
import type { Game, GameRound } from '../schemas/index.js';

export const GameNotFoundError = makeNotFoundError('Game');

export const GameRoundNotFoundError = makeNotFoundError('GameRound');

function toGame(record: typeof game.$inferSelect): Game {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    category: record.category,
    thumbnailUrl: record.thumbnailUrl,
    isActive: record.isActive,
    metadata: record.metadata,
  };
}

function toGameRound(record: typeof gameRound.$inferSelect): GameRound {
  return {
    id: record.id,
    gameId: record.gameId,
    userId: record.userId,
    status: record.status as GameRound['status'],
    betAmount: record.betAmount.toString(),
    winAmount: record.winAmount.toString(),
    currency: record.currency,
    startedAt: record.startedAt.toISOString(),
    endedAt: record.endedAt ? record.endedAt.toISOString() : null,
  };
}

export class GamingService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly provider: GameAdapter,
  ) {}

  // Authenticated lobby: the caller's tenant is verified server-side (ADR-0018/0019)
  // and passed in. Runs on the RLS-enforced `this.drizzle.db`; the explicit tenant
  // filter is defense-in-depth on top of the policy.
  async listGames(tenantId: string): Promise<Game[]> {
    const games = await this.drizzle.db
      .select()
      .from(game)
      .where(and(eq(game.isActive, true), eq(game.tenantId, tenantId)))
      .orderBy(asc(game.name));
    return games.map(toGame);
  }

  // Public/anonymous lobby: a pre-auth caller has no tenant GUC, so the RLS app role
  // would return zero rows (fail-closed). The public catalog is read-only and the
  // tenant is the server-side DEFAULT_TENANT_ID constant (never client input), so we
  // read it through the BYPASSRLS adminDb with an EXPLICIT tenant filter. This is the
  // single sanctioned pre-auth read; the authenticated path stays on the RLS db.
  // Multi-brand operators override the pre-auth tenant by resolving it from host/brand.
  async listPublicGames(): Promise<Game[]> {
    const games = await this.drizzle.adminDb
      .select()
      .from(game)
      .where(and(eq(game.isActive, true), eq(game.tenantId, DEFAULT_TENANT_ID)))
      .orderBy(asc(game.name));
    return games.map(toGame);
  }

  async getGame(id: string): Promise<Game> {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(game).where(eq(game.id, id)),
      new GameNotFoundError(id),
    );
    return toGame(record);
  }

  async startRound(
    userId: string,
    gameId: string,
    currency: string,
  ): Promise<{ roundId: string; launchUrl: string; token: string }> {
    await this.getGame(gameId);

    const { launchUrl, token } = await this.provider.launchGame(gameId, userId, currency);

    const [round] = await this.drizzle.db
      .insert(gameRound)
      .values({
        gameId,
        userId,
        currency,
        status: 'active',
        // Request tenant (ADR-0018) - satisfies the RLS WITH CHECK policy.
        tenantId: getCurrentTenantId() ?? 'default',
      })
      .returning();

    this.events.emit('gaming.round.started', {
      roundId: round!.id,
      gameId,
      userId,
      currency,
    });

    return { roundId: round!.id, launchUrl, token };
  }

  async endRound(userId: string, roundId: string): Promise<{ success: true; outcome?: unknown }> {
    const round = findOneOrThrow(
      await this.drizzle.db.select().from(gameRound).where(eq(gameRound.id, roundId)),
      new GameRoundNotFoundError(roundId),
    );

    await this.provider.endRound(roundId);

    await this.drizzle.db
      .update(gameRound)
      .set({ status: 'completed', endedAt: new Date() })
      .where(eq(gameRound.id, roundId));

    this.events.emit('gaming.round.ended', { roundId, userId });

    return { success: true };
  }

  async getUserRounds(userId: string): Promise<GameRound[]> {
    const rounds = await this.drizzle.db
      .select()
      .from(gameRound)
      .where(eq(gameRound.userId, userId))
      .orderBy(desc(gameRound.startedAt))
      .limit(50);
    return rounds.map(toGameRound);
  }
}

import {
  type EventBus,
  type DrizzleDb,
  createDomainError,
  makeNotFoundError,
  makeConflictError,
  DrizzleService,
  findOneOrThrow,
  serializeRow,
} from '@openora/core/server';
import { eq, and, asc, desc, sql } from 'drizzle-orm';
import {
  RgLimitExceededError,
  type GameAdapter,
  type PlayEligibilityPort,
  type RgLimitsPort,
  type WalletCommands,
  type IdentityReader,
  type User,
} from '@openora/core/contracts';
import { game, gameRound, type Game, type GameRound } from '../schema/index.js';

export const GameNotFoundError = makeNotFoundError('Game');

export const GameRoundNotFoundError = makeNotFoundError('GameRound');

export const RgRestrictedError = makeConflictError(
  'RgRestrictedError',
  'play is restricted by an active responsible-gambling exclusion',
);
export const InsufficientBalanceError = createDomainError<[available: string, requested: string]>(
  'InsufficientBalanceError',
  (available, requested) => `Insufficient balance: available ${available}, requested ${requested}`,
);
// Thrown inside the settlement transaction, so the round stays `active` and the win can be
// settled again rather than being lost silently.
export const WinCreditFailedError = createDomainError<[roundId: string, reason: string]>(
  'WinCreditFailedError',
  (roundId, reason) => `win credit failed for round ${roundId}: ${reason}`,
);

function toGame(record: typeof game.$inferSelect) {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    category: record.category,
    gameType: record.gameType,
    thumbnailUrl: record.thumbnailUrl,
    isActive: record.isActive,
    metadata: record.metadata,
  };
}

function toGameRound(record: typeof gameRound.$inferSelect) {
  return serializeRow(record, { dateFields: ['startedAt', 'endedAt'] });
}

export class GamingService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly provider: GameAdapter,
    private readonly playEligibility: PlayEligibilityPort,
    private readonly walletCommands: WalletCommands,
    private readonly identityReader: IdentityReader,
    private readonly rgLimits?: RgLimitsPort,
  ) {}

  async listGames() {
    const games = await this.drizzle.db
      .select()
      .from(game)
      .where(eq(game.isActive, true))
      .orderBy(asc(game.name));
    return games.map(toGame);
  }

  async getGame(id: string) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(game).where(eq(game.id, id)),
      new GameNotFoundError(id),
    );
    return toGame(record);
  }

  async startRound(userId: User['id'], gameId: Game['id'], currency: string, betAmount: string) {
    if (await this.playEligibility.isRestricted(userId)) {
      throw new RgRestrictedError();
    }
    const decision = await this.rgLimits?.checkWager(this.drizzle.db, userId, betAmount, currency);
    if (decision && !decision.allowed) {
      throw new RgLimitExceededError('wager_limit_exceeded', decision);
    }

    await this.getGame(gameId);

    const { round, completedBonusCredits } = await this.drizzle.db.transaction(async (tx) => {
      // The same currency the RG pre-check above weighed. Left off, the debit falls on the
      // player's active currency, and the two would then judge different moves.
      const outcome = await this.walletCommands.debit(tx, {
        userId,
        amount: betAmount,
        currency,
        type: 'bet',
      });
      if (!outcome.ok) {
        throw new InsufficientBalanceError(outcome.available, betAmount);
      }
      const insertedRound = findOneOrThrow(
        await tx
          .insert(gameRound)
          .values({
            gameId,
            userId,
            currency,
            betAmount,
            status: 'active',
          })
          .returning(),
        new GameRoundNotFoundError(gameId),
      );
      return { round: insertedRound, completedBonusCredits: outcome.completedBonusCredits ?? [] };
    });

    for (const credit of completedBonusCredits) {
      this.events.emit('wallet.bonus_rollover.completed', {
        userId,
        creditId: credit.id,
        currency: credit.currency,
        creditedAmount: credit.creditedAmount,
      });
    }

    const { launchUrl, token } = await this.provider.launchGame(gameId, userId, currency);

    this.events.emit('gaming.round.started', {
      roundId: round.id,
      gameId,
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      currency,
    });

    return { roundId: round.id, launchUrl, token };
  }

  async endRound(
    userId: User['id'],
    roundId: GameRound['id'],
  ): Promise<{ success: true; winAmount: string }> {
    // Without RLS (ADR-0026, single-tenant) this userId filter is the sole access guard.
    const round = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(gameRound)
        .where(and(eq(gameRound.id, roundId), eq(gameRound.userId, userId))),
      new GameRoundNotFoundError(roundId),
    );

    // A round that already closed reports what it paid and stops here - re-calling the
    // provider would ask a settled round for its outcome a second time.
    if (round.status !== 'active') {
      return { success: true, winAmount: round.winAmount };
    }

    const outcome = await this.provider.endRound(roundId);
    // The provider's number, never the caller's: the win is credited off this alone.
    const winAmount = outcome?.winAmount ?? '0';

    const paid = await this.drizzle.db.transaction(async (tx) => {
      // `status = 'active'` is the payout guard: two concurrent end-round calls both
      // reach here, only one updates a row, so the win is credited exactly once.
      const settled = await tx
        .update(gameRound)
        .set({ status: 'completed', endedAt: new Date(), winAmount })
        .where(
          and(
            eq(gameRound.id, roundId),
            eq(gameRound.userId, userId),
            eq(gameRound.status, 'active'),
          ),
        )
        .returning({ id: gameRound.id });
      if (settled.length === 0) {
        return false;
      }
      if (Number(winAmount) > 0) {
        // The bet already opened this currency's balance, so `allowNewCurrency` only
        // covers a player whose active currency moved between start and settlement.
        const credited = await this.walletCommands.credit(tx, {
          userId,
          amount: winAmount,
          currency: round.currency,
          type: 'win',
          allowNewCurrency: true,
        });
        if (!credited.ok) {
          throw new WinCreditFailedError(roundId, credited.reason);
        }
      }
      return true;
    });

    this.events.emit('gaming.round.ended', {
      roundId,
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
    });

    return { success: true, winAmount: paid ? winAmount : round.winAmount };
  }

  /**
   * `targetWhere` must repeat the partial index's predicate (schema/index.ts) - Postgres
   * rejects ON CONFLICT against a partial index without it. Deltas add onto the stored
   * value, not `excluded.<col>`, so concurrent callbacks each apply their own delta.
   */
  async accumulateExternalRound(
    tx: unknown,
    args: {
      gameId: Game['id'];
      userId: User['id'];
      currency: string;
      externalRoundId: NonNullable<GameRound['externalRoundId']>;
      betDelta?: string;
      winDelta?: string;
      isFinal?: boolean;
    },
  ): Promise<{ roundId: GameRound['id']; betAmount: string; winAmount: string }> {
    const txn = tx as DrizzleDb;
    const betDelta = args.betDelta ?? '0';
    const winDelta = args.winDelta ?? '0';
    const status = args.isFinal ? 'completed' : 'active';
    const endedAt = args.isFinal ? new Date() : undefined;
    const [row] = await txn
      .insert(gameRound)
      .values({
        gameId: args.gameId,
        userId: args.userId,
        currency: args.currency,
        externalRoundId: args.externalRoundId,
        betAmount: betDelta,
        winAmount: winDelta,
        status,
        endedAt,
      })
      .onConflictDoUpdate({
        target: gameRound.externalRoundId,
        targetWhere: sql`${gameRound.externalRoundId} IS NOT NULL`,
        set: {
          betAmount: sql`${gameRound.betAmount} + ${betDelta}::numeric`,
          winAmount: sql`${gameRound.winAmount} + ${winDelta}::numeric`,
          ...(args.isFinal ? { status, endedAt } : {}),
        },
      })
      .returning({
        id: gameRound.id,
        betAmount: gameRound.betAmount,
        winAmount: gameRound.winAmount,
      });
    if (!row) {
      throw new Error('accumulateExternalRound: no row');
    }
    return { roundId: row.id, betAmount: row.betAmount, winAmount: row.winAmount };
  }

  async getUserRounds(userId: User['id']) {
    const rounds = await this.drizzle.db
      .select()
      .from(gameRound)
      .where(eq(gameRound.userId, userId))
      .orderBy(desc(gameRound.startedAt))
      .limit(50);
    return rounds.map(toGameRound);
  }
}

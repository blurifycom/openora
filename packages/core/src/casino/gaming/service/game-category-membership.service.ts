import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  createDomainError,
  createLogger,
  DrizzleService,
  type DrizzleDb,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import type { JobQueueAdapter } from '@openora/core/contracts';
import { game, gameCategory, gameCategoryGame, type GameCategory } from '../schema/index.js';
import { SYSTEM_ACTOR_ID, type GameCategoryMembershipJob } from '../contract/index.js';
import { rankDirtyPatch, type CatalogActor } from '../../shared/game-catalog.js';
import { GameCategoryNotFoundError } from './game-category.service.js';
import {
  GameCategoryRuleInvalidError,
  isUnresolvableRuleError,
  type GameCategoryRuleService,
} from './game-category-rule.service.js';
import { enqueueGameCategoryRank } from './game-sort-trigger.service.js';

const logger = createLogger('gaming');

export const GameCategoryRuleManagedError = createDomainError<[categoryId: string]>(
  'GameCategoryRuleManagedError',
  (categoryId) =>
    `Category ${categoryId} is populated by a rule; its games cannot be added or removed by hand`,
);
export const GameCategoryNotRuleManagedError = createDomainError<[categoryId: string]>(
  'GameCategoryNotRuleManagedError',
  (categoryId) => `Category ${categoryId} is not in rule mode`,
);
export const GameCategoryMembershipContendedError = createDomainError<[categoryId: string]>(
  'GameCategoryMembershipContendedError',
  (categoryId) => `Category ${categoryId} kept changing while its rule was being evaluated`,
);

const MAX_EVALUATE_ATTEMPTS = 3;
const MEMBERSHIP_LAST_ERROR_MAX = 500;

export type MembershipDiff = {
  toAdd: string[];
  toRemove: string[];
};

/** The inserts and deletes that turn `currentIds` into `matchedIds`. */
export function diffMembership(
  currentIds: readonly string[],
  matchedIds: readonly string[],
): MembershipDiff {
  const current = new Set(currentIds);
  const matched = new Set(matchedIds);
  return {
    toAdd: [...matched].filter((id) => !current.has(id)),
    toRemove: [...current].filter((id) => !matched.has(id)),
  };
}

type EvaluateArgs = {
  categoryId: GameCategory['id'];
  trigger: 'admin' | GameCategoryMembershipJob['trigger'];
  actor?: CatalogActor;
};

type EvaluationSnapshot = Pick<GameCategory, 'membershipRule' | 'membershipSeq'>;

type LockedDiff =
  | { status: 'gone' }
  | { status: 'stale' }
  | { status: 'ready'; diff: MembershipDiff; matchedCount: number };

type Applied = {
  diff: MembershipDiff;
  matchedCount: number;
  relabeledCount: number;
  evaluatedAt: Date;
};

/**
 * Owns the `game_category_game` rows of every rule-mode category: writes what
 * GameCategoryRuleService resolves as a diff, so every reader keeps joining the link
 * table unchanged. See docs/modules/gaming.md for the lock order.
 */
export class GameCategoryMembershipService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly jobQueue: JobQueueAdapter,
    private readonly rules: GameCategoryRuleService,
  ) {}

  /**
   * Re-materializes one rule-mode category. Throws `GameCategoryNotFoundError` or
   * `GameCategoryNotRuleManagedError` when there is nothing to evaluate, an unresolvable
   * rule's error, or `GameCategoryMembershipContendedError` after three stale attempts.
   * A repeat run with nothing to change writes no link rows.
   */
  async evaluate({ categoryId, trigger, actor }: EvaluateArgs) {
    for (let attempt = 0; attempt < MAX_EVALUATE_ATTEMPTS; attempt += 1) {
      const snapshot = await this.claimEvaluation(categoryId);
      const outcome = await this.evaluateOnce(categoryId, snapshot);
      if (outcome === 'stale') {
        if (attempt === MAX_EVALUATE_ATTEMPTS - 1) {
          await this.recordFailedAttempt(
            categoryId,
            snapshot,
            new GameCategoryMembershipContendedError(categoryId),
          );
        }
        continue;
      }
      this.publish(categoryId, trigger, actor, outcome);
      return {
        matchedCount: outcome.matchedCount,
        addedCount: outcome.diff.toAdd.length,
        removedCount: outcome.diff.toRemove.length,
        evaluatedAt: outcome.evaluatedAt.toISOString(),
      };
    }
    throw new GameCategoryMembershipContendedError(categoryId);
  }

  /**
   * The job entry point, as the system actor. A category deleted or switched to manual
   * after the job was queued is skipped, and so is a rule that does not resolve - no
   * retry can fix it; the next sweep tries again in case an overlay came back.
   */
  async evaluateJob({ categoryId, trigger }: GameCategoryMembershipJob): Promise<void> {
    try {
      await this.evaluate({ categoryId, trigger });
    } catch (err) {
      if (
        err instanceof GameCategoryNotFoundError ||
        err instanceof GameCategoryNotRuleManagedError
      ) {
        logger.info({ categoryId }, 'gaming.category.membership: not rule-managed, skipping');
        return;
      }
      if (isUnresolvableRuleError(err)) {
        logger.warn({ err, categoryId }, 'gaming.category.membership: rule does not resolve');
        return;
      }
      throw err;
    }
  }

  // Lock order is games, then the category, then its link rows - the order updateGame and
  // the bulk actions take them in. Inserting a link locks its game row, so the rule is
  // resolved and the games to insert are read first, unlocked, then locked before the
  // category; the run is 'stale' and retried when the locked re-read disagrees.
  private async evaluateOnce(
    categoryId: GameCategory['id'],
    snapshot: EvaluationSnapshot,
  ): Promise<Applied | 'stale'> {
    const matchedIds = await this.resolveOrRecordFailure(categoryId, snapshot);
    if (matchedIds === 'stale') {
      return 'stale';
    }
    const currentIds = await this.memberIds(this.drizzle.db, categoryId);
    const toAdd = diffMembership(currentIds, matchedIds).toAdd;

    return this.drizzle.db.transaction(async (tx) => {
      const locked = await this.lockAndDiff(tx, { categoryId, snapshot, matchedIds, toAdd });
      if (locked.status === 'gone') {
        throw new GameCategoryNotFoundError(categoryId);
      }
      if (locked.status === 'stale') {
        return 'stale';
      }
      return this.applyDiff(tx, categoryId, locked.diff, locked.matchedCount);
    });
  }

  private async claimEvaluation(categoryId: GameCategory['id']) {
    const [snapshot] = await this.drizzle.db
      .update(gameCategory)
      .set({
        membershipSeq: sql`${gameCategory.membershipSeq} + 1`,
        updatedAt: sql`${gameCategory.updatedAt}`,
      })
      .where(and(eq(gameCategory.id, categoryId), eq(gameCategory.membershipMode, 'rule')))
      .returning({
        membershipRule: gameCategory.membershipRule,
        membershipSeq: gameCategory.membershipSeq,
      });
    if (snapshot) {
      return snapshot;
    }
    const [existing] = await this.drizzle.db
      .select({ id: gameCategory.id })
      .from(gameCategory)
      .where(eq(gameCategory.id, categoryId))
      .limit(1);
    if (!existing) {
      throw new GameCategoryNotFoundError(categoryId);
    }
    throw new GameCategoryNotRuleManagedError(categoryId);
  }

  // A null rule in rule mode is a stored value that no longer parses (zodJsonb reads it
  // as null): a rule that does not resolve, never a manual category.
  private async resolveOrRecordFailure(
    categoryId: GameCategory['id'],
    snapshot: EvaluationSnapshot,
  ) {
    try {
      const rule = snapshot.membershipRule;
      if (!rule) {
        throw new GameCategoryRuleInvalidError('The stored rule no longer matches its contract');
      }
      return await this.rules.resolveGameIds(rule);
    } catch (err) {
      if (!(await this.recordFailedAttempt(categoryId, snapshot, err))) {
        return 'stale';
      }
      throw err;
    }
  }

  private async lockAndDiff(
    tx: DrizzleTx,
    {
      categoryId,
      snapshot,
      matchedIds,
      toAdd,
    }: {
      categoryId: GameCategory['id'];
      snapshot: EvaluationSnapshot;
      matchedIds: readonly string[];
      toAdd: readonly string[];
    },
  ): Promise<LockedDiff> {
    const lockedGameIds = await this.lockGames(tx, toAdd);
    const [locked] = await tx
      .select({
        mode: gameCategory.membershipMode,
        rule: gameCategory.membershipRule,
        membershipSeq: gameCategory.membershipSeq,
      })
      .from(gameCategory)
      .where(eq(gameCategory.id, categoryId))
      .limit(1)
      .for('update');
    if (!locked) {
      return { status: 'gone' };
    }
    if (
      locked.mode !== 'rule' ||
      locked.membershipSeq !== snapshot.membershipSeq ||
      !isDeepStrictEqual(locked.rule, snapshot.membershipRule)
    ) {
      return { status: 'stale' };
    }
    // A game to add that was deleted since the unlocked read is no longer a match.
    const pendingAdd = new Set(toAdd);
    const liveMatchedIds = matchedIds.filter((id) => !pendingAdd.has(id) || lockedGameIds.has(id));
    const diff = diffMembership(await this.memberIds(tx, categoryId), liveMatchedIds);
    if (diff.toAdd.some((id) => !lockedGameIds.has(id))) {
      return { status: 'stale' };
    }
    return { status: 'ready', diff, matchedCount: liveMatchedIds.length };
  }

  private async lockGames(tx: DrizzleTx, gameIds: readonly string[]) {
    if (gameIds.length === 0) {
      return new Set<string>();
    }
    const rows = await tx
      .select({ id: game.id })
      .from(game)
      .where(sql`${game.id} = ANY(${sql.param([...gameIds])}::uuid[])`)
      .orderBy(asc(game.id))
      .for('key share');
    return new Set(rows.map((row) => row.id));
  }

  private async applyDiff(
    tx: DrizzleTx,
    categoryId: GameCategory['id'],
    diff: MembershipDiff,
    matchedCount: number,
  ): Promise<Applied> {
    const changed = diff.toAdd.length > 0 || diff.toRemove.length > 0;
    const [stamped] = await tx
      .update(gameCategory)
      .set({
        membershipEvaluatedAt: sql`now()`,
        membershipAttemptedAt: sql`now()`,
        membershipLastError: null,
        updatedAt: sql`${gameCategory.updatedAt}`,
        ...(changed ? rankDirtyPatch() : {}),
      })
      .where(eq(gameCategory.id, categoryId))
      .returning({ evaluatedAt: gameCategory.membershipEvaluatedAt });
    if (diff.toRemove.length > 0) {
      await tx
        .delete(gameCategoryGame)
        .where(
          and(
            eq(gameCategoryGame.categoryId, categoryId),
            sql`${gameCategoryGame.gameId} = ANY(${sql.param(diff.toRemove)}::uuid[])`,
          ),
        );
    }
    if (diff.toAdd.length > 0) {
      // One array parameter: a row-per-value insert would outgrow the bind-parameter limit.
      await tx.execute(sql`
        INSERT INTO game_category_game (game_id, category_id, source)
        SELECT g, ${categoryId}::uuid, 'rule'
        FROM unnest(${sql.param(diff.toAdd)}::uuid[]) AS g
      `);
    }
    // Rows an admin added before the switch to rule mode that the rule also matches.
    const relabeled = await tx
      .update(gameCategoryGame)
      .set({ source: 'rule' })
      .where(
        and(eq(gameCategoryGame.categoryId, categoryId), eq(gameCategoryGame.source, 'manual')),
      )
      .returning({ gameId: gameCategoryGame.gameId });
    return {
      diff,
      matchedCount,
      relabeledCount: relabeled.length,
      evaluatedAt: stamped?.evaluatedAt ?? new Date(),
    };
  }

  // After commit: re-rank when games moved; audit any write, and every run an admin asked for.
  private publish(
    categoryId: GameCategory['id'],
    trigger: EvaluateArgs['trigger'],
    actor: CatalogActor | undefined,
    { diff, matchedCount, relabeledCount }: Applied,
  ) {
    const changed = diff.toAdd.length > 0 || diff.toRemove.length > 0;
    if (changed) {
      enqueueGameCategoryRank(this.jobQueue, categoryId);
    }
    if (!changed && relabeledCount === 0 && trigger !== 'admin') {
      return;
    }
    this.events.emit('gaming.category.membership_evaluated', {
      categoryId,
      actorId: actor?.actorId ?? SYSTEM_ACTOR_ID,
      trigger,
      matchedCount,
      relabeledCount,
      addedGameIds: diff.toAdd,
      removedGameIds: diff.toRemove,
      ip: actor?.ip ?? null,
      userAgent: actor?.userAgent ?? null,
    });
  }

  // Records the attempt and its reason, leaving membershipEvaluatedAt at the last success,
  // so a stuck rule never looks fresh and moves to the back of the sweep. Only this
  // module's own messages are stored. Best effort: a failure here is logged, not thrown,
  // so the caller still sees the error that mattered.
  private async recordFailedAttempt(
    categoryId: GameCategory['id'],
    snapshot: EvaluationSnapshot,
    err: unknown,
  ) {
    const reason =
      isUnresolvableRuleError(err) || err instanceof GameCategoryMembershipContendedError
        ? err.message
        : 'The rule could not be evaluated';
    try {
      const recorded = await this.drizzle.db
        .update(gameCategory)
        .set({
          membershipAttemptedAt: sql`now()`,
          membershipLastError: reason.slice(0, MEMBERSHIP_LAST_ERROR_MAX),
          updatedAt: sql`${gameCategory.updatedAt}`,
        })
        .where(
          and(
            eq(gameCategory.id, categoryId),
            eq(gameCategory.membershipMode, 'rule'),
            eq(gameCategory.membershipSeq, snapshot.membershipSeq),
          ),
        )
        .returning({ id: gameCategory.id });
      return recorded.length > 0;
    } catch (recordErr) {
      logger.error(
        { err: recordErr, categoryId },
        'gaming.category.membership: could not record a failed attempt',
      );
      return true;
    }
  }

  private async memberIds(db: DrizzleDb | DrizzleTx, categoryId: GameCategory['id']) {
    const rows = await db
      .select({ gameId: gameCategoryGame.gameId })
      .from(gameCategoryGame)
      .where(eq(gameCategoryGame.categoryId, categoryId));
    return rows.map((row) => row.gameId);
  }
}

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
import type { GameCategoryMembershipTrigger, JobQueueAdapter } from '@openora/core/contracts';
import { game, gameCategory, gameCategoryGame, type GameCategory } from '../schema/index.js';
import { SYSTEM_ACTOR_ID, type GameCategoryMembershipJob } from '../contract/index.js';
import { rankDirtyPatch, type CatalogActor } from '../../shared/game-catalog.js';
import { GameCategoryNotFoundError } from './game-category.service.js';
import {
  GameCategoryRuleInvalidError,
  GameCategoryRuleUnavailableError,
  isUnresolvableRuleError,
  type GameCategoryRuleAuthorizer,
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

export function failureReason(err: unknown) {
  const reason =
    isUnresolvableRuleError(err) ||
    err instanceof GameCategoryRuleUnavailableError ||
    err instanceof GameCategoryMembershipContendedError
      ? err.message
      : 'The rule could not be evaluated';
  return reason.slice(0, MEMBERSHIP_LAST_ERROR_MAX);
}

export type MembershipDiff = {
  toAdd: string[];
  toRemove: string[];
};

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
  trigger: GameCategoryMembershipTrigger;
  actor?: CatalogActor;
  authorizeRule?: GameCategoryRuleAuthorizer;
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

export class GameCategoryMembershipService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly jobQueue: JobQueueAdapter,
    private readonly rules: GameCategoryRuleService,
  ) {}

  async evaluate(args: EvaluateArgs) {
    const { categoryId, trigger, actor, authorizeRule } = args;
    for (let attempt = 0; attempt < MAX_EVALUATE_ATTEMPTS; attempt += 1) {
      const snapshot = await this.claimEvaluation(categoryId);
      if (authorizeRule && snapshot.membershipRule) {
        await authorizeRule(snapshot.membershipRule);
      }
      const outcome = await this.evaluateOnce(args, snapshot);
      if (outcome === 'stale') {
        if (attempt === MAX_EVALUATE_ATTEMPTS - 1) {
          const contended = new GameCategoryMembershipContendedError(categoryId);
          await this.recordFailedAttempt(categoryId, snapshot, contended);
          this.publishFailure(args, contended);
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

  private async evaluateOnce(
    args: EvaluateArgs,
    snapshot: EvaluationSnapshot,
  ): Promise<Applied | 'stale'> {
    const { categoryId } = args;
    const matchedIds = await this.resolveOrRecordFailure(args, snapshot);
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

  private async resolveOrRecordFailure(args: EvaluateArgs, snapshot: EvaluationSnapshot) {
    try {
      const rule = snapshot.membershipRule;
      if (!rule) {
        throw new GameCategoryRuleInvalidError('The stored rule no longer matches its contract');
      }
      return await this.rules.resolveGameIds(rule);
    } catch (err) {
      if (!(await this.recordFailedAttempt(args.categoryId, snapshot, err))) {
        return 'stale';
      }
      this.publishFailure(args, err);
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
      await tx.execute(sql`
        INSERT INTO game_category_game (game_id, category_id, source)
        SELECT g, ${categoryId}::uuid, 'rule'
        FROM unnest(${sql.param(diff.toAdd)}::uuid[]) AS g
      `);
    }
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

  private publishFailure({ categoryId, trigger, actor }: EvaluateArgs, err: unknown) {
    if (trigger !== 'admin') {
      return;
    }
    this.events.emit('gaming.category.membership_evaluation.failed', {
      categoryId,
      actorId: actor?.actorId ?? SYSTEM_ACTOR_ID,
      reason: failureReason(err),
      ip: actor?.ip ?? null,
      userAgent: actor?.userAgent ?? null,
    });
  }

  private async recordFailedAttempt(
    categoryId: GameCategory['id'],
    snapshot: EvaluationSnapshot,
    err: unknown,
  ) {
    try {
      const recorded = await this.drizzle.db
        .update(gameCategory)
        .set({
          membershipAttemptedAt: sql`now()`,
          membershipLastError: failureReason(err),
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

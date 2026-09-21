import {
  type EventBus,
  type DrizzleTx,
  makeConflictError,
  createDomainError,
  makeNotFoundError,
  createLogger,
  DrizzleService,
  findOneOrThrow,
  isUniqueConstraintViolation,
  likeContains,
  serializeRow,
  pageToOffset,
} from '@openora/core/server';
import { and, asc, count, eq, ilike, isNotNull, ne, or, sql } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import type { GameCategoryRule, JobQueueAdapter } from '@openora/core/contracts';
import { GameSortService } from './game-sort.service.js';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';
import type {
  CreateCategoryInput,
  ReorderCategoryGamesInput,
  UpdateCategoryInput,
  UpdateCategoryPinsInput,
} from '../contract/index.js';
import { enqueueGameCategoryRank } from './game-sort-trigger.service.js';
import type { GameCategoryRuleService } from './game-category-rule.service.js';
import {
  categoryGameOrder,
  rankDirtyPatch,
  categorySummaryColumns,
  providerSummaryColumns,
  toCategorySummary,
  type CatalogActor,
} from '../../shared/game-catalog.js';

const logger = createLogger('gaming');

export const GameCategoryNotFoundError = makeNotFoundError('GameCategory');
export const GameCategoryRuleRequiredError = createDomainError<[]>(
  'GameCategoryRuleRequiredError',
  () => 'A category in rule mode needs a membershipRule',
);

// What this service needs of GameCategoryMembershipService. Declared here rather than
// imported: that service imports this file's errors, and the two must not form a cycle.
export type CategoryMembershipEvaluator = {
  evaluate(args: { categoryId: string; trigger: 'admin'; actor: CatalogActor }): Promise<unknown>;
};
export const GameCategorySlugTakenError = makeConflictError(
  'GameCategorySlugTakenError',
  'A category with this slug already exists',
);
export const GameCategoryUpdateContendedError = makeConflictError(
  'GameCategoryUpdateContendedError',
  'The category kept changing while its rule was being checked; retry the update',
);
export const CategoryGameNotMemberError = createDomainError<[gameId: string, categoryId: string]>(
  'CategoryGameNotMemberError',
  (gameId, categoryId) => `Game ${gameId} is not a member of category ${categoryId}`,
);

const MAX_UPDATE_ATTEMPTS = 3;

function categorySnapshot(record: typeof gameCategory.$inferSelect) {
  return {
    slug: record.slug,
    name: record.name,
    translations: record.translations ?? {},
    icon: record.icon,
    sortOrder: record.sortOrder,
    isActive: record.isActive,
    sortKey: record.sortKey,
    sortDirection: record.sortDirection,
    sortParams: record.sortParams ?? {},
    rankedAt: record.rankedAt ? record.rankedAt.toISOString() : null,
    membershipMode: record.membershipMode,
    membershipRule: record.membershipRule ?? null,
  };
}

function toCategoryDetail(record: typeof gameCategory.$inferSelect) {
  const dates = serializeRow(record, { dateFields: ['createdAt', 'updatedAt'] });
  return {
    ...toCategorySummary(record),
    isActive: record.isActive,
    sortKey: record.sortKey,
    sortDirection: record.sortDirection,
    sortParams: record.sortParams ?? {},
    rankedAt: record.rankedAt ? record.rankedAt.toISOString() : null,
    membershipMode: record.membershipMode,
    membershipRule: record.membershipRule ?? null,
    membershipEvaluatedAt: record.membershipEvaluatedAt
      ? record.membershipEvaluatedAt.toISOString()
      : null,
    membershipAttemptedAt: record.membershipAttemptedAt
      ? record.membershipAttemptedAt.toISOString()
      : null,
    membershipLastError: record.membershipLastError,
    createdAt: dates.createdAt,
    updatedAt: dates.updatedAt,
  };
}

export class GameCategoryService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly jobQueue: JobQueueAdapter,
    private readonly sorts: GameSortService,
    private readonly rules: GameCategoryRuleService,
    private readonly membership: CategoryMembershipEvaluator,
  ) {}

  // Locks a category row FOR UPDATE inside the caller's transaction, so a concurrent
  // PATCH/reorder/pin write serializes rather than racing - shared by every write path
  // below that needs the current row before deciding what changed.
  private async lockCategoryRow(tx: DrizzleTx, id: string) {
    return findOneOrThrow(
      await tx.select().from(gameCategory).where(eq(gameCategory.id, id)).limit(1).for('update'),
      new GameCategoryNotFoundError(id),
    );
  }

  async listActiveCategories({ page, limit }: { page: number; limit: number }) {
    const where = eq(gameCategory.isActive, true);
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select(categorySummaryColumns)
        .from(gameCategory)
        .where(where)
        .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name), asc(gameCategory.slug))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(gameCategory).where(where),
    ]);
    return {
      items: rows.map((row) => ({ ...row, translations: row.translations ?? {} })),
      total: Number(n),
      page,
      limit,
    };
  }

  async listCategoriesAdmin({
    page,
    limit,
    q,
    isActive,
  }: {
    page: number;
    limit: number;
    q?: string;
    isActive?: boolean;
  }) {
    const where = and(
      q
        ? or(ilike(gameCategory.name, likeContains(q)), ilike(gameCategory.slug, likeContains(q)))
        : undefined,
      isActive === undefined ? undefined : eq(gameCategory.isActive, isActive),
    );
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select()
        .from(gameCategory)
        .where(where)
        .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(gameCategory).where(where),
    ]);
    return { items: rows.map(toCategoryDetail), total: Number(n), page, limit };
  }

  async getCategory(id: string) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(gameCategory).where(eq(gameCategory.id, id)).limit(1),
      new GameCategoryNotFoundError(id),
    );
    return toCategoryDetail(record);
  }

  async getActiveCategoryBySlug(slug: string) {
    const record = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(gameCategory)
        .where(and(eq(gameCategory.slug, slug), eq(gameCategory.isActive, true)))
        .limit(1),
      new GameCategoryNotFoundError(slug),
    );
    return toCategorySummary(record);
  }

  async createCategory({
    slug,
    name,
    translations,
    icon,
    sortOrder,
    membershipMode,
    membershipRule,
    actorId,
    ip,
    userAgent,
  }: CreateCategoryInput & CatalogActor) {
    if (membershipMode === 'rule' && membershipRule === undefined) {
      throw new GameCategoryRuleRequiredError();
    }
    const rule = membershipRule ? await this.rules.normalizeRule(membershipRule) : null;
    let record: typeof gameCategory.$inferSelect;
    try {
      record = await this.drizzle.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: gameCategory.id })
          .from(gameCategory)
          .where(eq(gameCategory.slug, slug))
          .limit(1);
        if (existing) {
          throw new GameCategorySlugTakenError();
        }
        const [created] = await tx
          .insert(gameCategory)
          .values({
            slug,
            name,
            translations: translations ?? {},
            icon: icon ?? null,
            sortOrder: sortOrder ?? 0,
            membershipMode: membershipMode ?? 'manual',
            membershipRule: rule,
          })
          .returning();
        return created;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new GameCategorySlugTakenError();
      }
      throw error;
    }
    this.events.emit('gaming.category.created', {
      categoryId: record.id,
      ...categorySnapshot(record),
      actorId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    if (record.membershipMode === 'rule') {
      return this.evaluateAfterWrite(record.id, { actorId, ip, userAgent });
    }
    return toCategoryDetail(record);
  }

  // A category that just entered rule mode, or whose rule just changed, is populated
  // before the write returns, so the caller never sees the old games under the new rule.
  // Runs after the config commit, not inside it: the evaluator locks games before the
  // category (docs/modules/gaming.md), the opposite of a transaction that already holds
  // the category row. A failure here is logged, not thrown - the config write is already
  // committed and audited, and the membership sweep retries the evaluation.
  private async evaluateAfterWrite(id: string, actor: CatalogActor) {
    try {
      await this.membership.evaluate({ categoryId: id, trigger: 'admin', actor });
    } catch (err) {
      logger.error({ err, categoryId: id }, 'gaming.category.membership: evaluation failed');
    }
    return this.getCategory(id);
  }

  async updateCategory({
    id,
    actorId,
    ip,
    userAgent,
    sortKey,
    sortDirection,
    sortParams,
    membershipMode,
    membershipRule,
    ...patchInput
  }: UpdateCategoryInput & CatalogActor) {
    const scalarPatch: Partial<typeof gameCategory.$inferInsert> = { ...patchInput };
    const hasScalarChanges = Object.values(scalarPatch).some((value) => value !== undefined);
    const wantsSortChange =
      sortKey !== undefined || sortDirection !== undefined || sortParams !== undefined;

    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      const normalized = await this.normalizeMembershipPatch(id, membershipMode, membershipRule);
      const outcome = await this.applyCategoryUpdate({
        id,
        scalarPatch,
        hasScalarChanges,
        sort: wantsSortChange ? { sortKey, sortDirection, sortParams } : null,
        membershipMode,
        membershipRule,
        normalized,
      });
      if (outcome === 'stale') {
        continue;
      }
      return this.finishCategoryUpdate(id, outcome, { actorId, ip, userAgent });
    }
    throw new GameCategoryUpdateContendedError();
  }

  // Runs the rule catalog - arbitrary definition code, on its own pooled connections -
  // BEFORE the update transaction, never inside it: holding the category row lock and a
  // connection across that would let a handful of concurrent PATCHes exhaust the pool.
  // Returns the rule that was checked next to its normalized form, so the transaction
  // can confirm under the lock that it is still the rule in play.
  private async normalizeMembershipPatch(
    id: string,
    membershipMode: UpdateCategoryInput['membershipMode'],
    membershipRule: UpdateCategoryInput['membershipRule'],
  ) {
    if (membershipMode === undefined && membershipRule === undefined) {
      return null;
    }
    const existing = findOneOrThrow(
      await this.drizzle.db
        .select({ mode: gameCategory.membershipMode, rule: gameCategory.membershipRule })
        .from(gameCategory)
        .where(eq(gameCategory.id, id))
        .limit(1),
      new GameCategoryNotFoundError(id),
    );
    const input = membershipRule ?? existing.rule;
    const switchesToRule = membershipMode === 'rule' && existing.mode !== 'rule';
    if (input === null || (membershipRule === undefined && !switchesToRule)) {
      return null;
    }
    return { input, rule: await this.rules.normalizeRule(input) };
  }

  private async applyCategoryUpdate({
    id,
    scalarPatch,
    hasScalarChanges,
    sort,
    membershipMode,
    membershipRule,
    normalized,
  }: {
    id: string;
    scalarPatch: Partial<typeof gameCategory.$inferInsert>;
    hasScalarChanges: boolean;
    sort: Pick<UpdateCategoryInput, 'sortKey' | 'sortDirection' | 'sortParams'> | null;
    membershipMode: UpdateCategoryInput['membershipMode'];
    membershipRule: UpdateCategoryInput['membershipRule'];
    normalized: { input: GameCategoryRule; rule: GameCategoryRule } | null;
  }) {
    return this.drizzle.db
      .transaction(async (tx) => {
        // The row lock serializes concurrent PATCHes, so the audited `before` is the
        // state this write replaced, never a snapshot another request already changed.
        const existing = await this.lockCategoryRow(tx, id);
        if (scalarPatch.slug !== undefined && scalarPatch.slug !== existing.slug) {
          const [clash] = await tx
            .select({ id: gameCategory.id })
            .from(gameCategory)
            .where(and(eq(gameCategory.slug, scalarPatch.slug), ne(gameCategory.id, id)))
            .limit(1);
          if (clash) {
            throw new GameCategorySlugTakenError();
          }
        }

        const sortPatch = sort
          ? this.sorts.resolvePatch(existing, sort)
          : { changed: false, patch: {} };

        const nextMode = membershipMode ?? existing.membershipMode;
        const modeChanged = nextMode !== existing.membershipMode;
        const candidateRule = membershipRule ?? existing.membershipRule;
        if (nextMode === 'rule' && !candidateRule) {
          throw new GameCategoryRuleRequiredError();
        }
        // Also on a bare switch to rule mode: the stored rule may name a provider, a tag
        // or a rule kind removed since it was saved, and evaluating it blind would empty
        // the category.
        const needsCheck =
          candidateRule !== null &&
          (membershipRule !== undefined || (modeChanged && nextMode === 'rule'));
        // The rule checked before this transaction must be the one in play now that the
        // row is locked - a concurrent PATCH may have replaced the stored rule or mode.
        if (needsCheck && !(normalized && isDeepStrictEqual(normalized.input, candidateRule))) {
          return 'stale' as const;
        }
        const nextRule = needsCheck && normalized ? normalized.rule : candidateRule;
        const ruleChanged = !isDeepStrictEqual(nextRule, existing.membershipRule);
        const membershipChanged = modeChanged || ruleChanged;

        const hasChanges = hasScalarChanges || sortPatch.changed || membershipChanged;
        if (!hasChanges) {
          return {
            changed: false as const,
            sortChanged: false,
            needsEvaluation: false,
            before: existing,
            after: existing,
          };
        }
        if (modeChanged && nextMode === 'manual') {
          // The games stay; from here on they are an admin's to add and remove.
          await tx
            .update(gameCategoryGame)
            .set({ source: 'manual' })
            .where(eq(gameCategoryGame.categoryId, id));
        }
        const patch = {
          ...scalarPatch,
          ...sortPatch.patch,
          ...(sortPatch.changed ? rankDirtyPatch() : {}),
          ...(membershipChanged
            ? {
                membershipMode: nextMode,
                membershipRule: nextRule,
                membershipSeq: sql`${gameCategory.membershipSeq} + 1`,
              }
            : {}),
          // A manual category is not evaluated: a rule's last attempt or error would only
          // mislead. The rule itself is kept, for a later switch back.
          ...(modeChanged && nextMode === 'manual'
            ? { membershipAttemptedAt: null, membershipLastError: null }
            : {}),
        };
        const updated = findOneOrThrow(
          await tx.update(gameCategory).set(patch).where(eq(gameCategory.id, id)).returning(),
          new GameCategoryNotFoundError(id),
        );
        return {
          changed: true as const,
          sortChanged: sortPatch.changed,
          needsEvaluation: membershipChanged && nextMode === 'rule',
          before: existing,
          after: updated,
        };
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintViolation(error)) {
          throw new GameCategorySlugTakenError();
        }
        throw error;
      });
  }

  private async finishCategoryUpdate(
    id: string,
    outcome: Exclude<Awaited<ReturnType<GameCategoryService['applyCategoryUpdate']>>, 'stale'>,
    { actorId, ip, userAgent }: CatalogActor,
  ) {
    if (!outcome.changed) {
      return toCategoryDetail(outcome.after);
    }
    this.events.emit('gaming.category.updated', {
      categoryId: id,
      actorId,
      before: categorySnapshot(outcome.before),
      after: categorySnapshot(outcome.after),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    if (outcome.sortChanged) {
      enqueueGameCategoryRank(this.jobQueue, id);
    }
    if (outcome.needsEvaluation) {
      return this.evaluateAfterWrite(id, { actorId, ip, userAgent });
    }
    return toCategoryDetail(outcome.after);
  }

  async listCategoryGames(id: string, { page, limit }: { page: number; limit: number }) {
    findOneOrThrow(
      await this.drizzle.db
        .select({ id: gameCategory.id })
        .from(gameCategory)
        .where(eq(gameCategory.id, id))
        .limit(1),
      new GameCategoryNotFoundError(id),
    );
    const where = eq(gameCategoryGame.categoryId, id);
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select({
          id: game.id,
          name: game.name,
          slug: game.slug,
          provider: providerSummaryColumns,
          thumbnailUrl: game.thumbnailUrl,
          isActive: game.isActive,
          position: gameCategoryGame.position,
          pinnedPosition: gameCategoryGame.pinnedPosition,
        })
        .from(gameCategoryGame)
        .innerJoin(game, eq(gameCategoryGame.gameId, game.id))
        .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
        .where(where)
        // Effective order (categoryGameOrder, single owner with the public read path),
        // not the operator's own manual `position` - see docs/modules/gaming.md.
        .orderBy(...categoryGameOrder())
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(gameCategoryGame).where(where),
    ]);
    return { items: rows, total: Number(n), page, limit };
  }

  async reorderCategoryGames({
    id,
    gameIds,
    actorId,
    ip,
    userAgent,
  }: ReorderCategoryGamesInput & CatalogActor) {
    const outcome = await this.drizzle.db.transaction(async (tx) => {
      // The row lock serializes a concurrent reorder/PATCH/pins write on this category -
      // last-write-wins, not optimistic concurrency (docs/modules/gaming.md).
      const category = await this.lockCategoryRow(tx, id);
      // Dragging any game always ends the category in manual sort - see docs/modules/gaming.md - so
      // 'manual' must be bound in the catalog regardless of the category's current key.
      this.sorts.requireDefinition('manual');

      // The full pre-drag effective order (categoryGameOrder semantics: rank, name, id)
      // - the same order every reader uses - so `before` below is the complete list the
      // write actually rewrote, not just the subset that already had a manual position.
      const memberRows = await tx
        .select({ gameId: gameCategoryGame.gameId })
        .from(gameCategoryGame)
        .innerJoin(game, eq(gameCategoryGame.gameId, game.id))
        .where(eq(gameCategoryGame.categoryId, id))
        .orderBy(...categoryGameOrder());
      const memberIds = new Set(memberRows.map((row) => row.gameId));
      const missingId = gameIds.find((gameId) => !memberIds.has(gameId));
      if (missingId !== undefined) {
        throw new CategoryGameNotMemberError(missingId, id);
      }

      const sortKeyBefore = category.sortKey;
      const sortDirectionBefore = category.sortDirection;
      const sortParamsBefore = category.sortParams ?? {};
      const before = memberRows.map((row) => row.gameId);

      if (gameIds.length > 0) {
        await tx.execute(sql`
          UPDATE game_category_game AS gcg
          SET position = (v.pos - 1)::int
          FROM unnest(${sql.param(gameIds)}::uuid[]) WITH ORDINALITY AS v(game_id, pos)
          WHERE gcg.category_id = ${id} AND gcg.game_id = v.game_id
            AND gcg.position IS DISTINCT FROM (v.pos - 1)::int
        `);
      }
      const listedIds = new Set(gameIds);
      // memberIds iterates in the same effective order as memberRows (Set preserves
      // insertion order), so this is already the pre-drag order minus the dragged ids -
      // exactly the tail `after` needs below.
      const unlistedIds = [...memberIds].filter((gameId) => !listedIds.has(gameId));
      if (unlistedIds.length > 0) {
        // Seeds every member the drag didn't touch from the category's pre-drag
        // effective order (rank), never null - keeps its visible position stable
        // across the switch to manual. Same NULLS-LAST ordering as categoryGameOrder()
        // (shared/game-catalog.ts) - inlined here in raw SQL rather than shared, since
        // this query also needs the row id and the != ALL exclusion. See docs/modules/gaming.md.
        await tx.execute(sql`
          WITH unlisted AS (
            SELECT gcg.id, gcg.position AS current_position,
                   row_number() OVER (ORDER BY gcg.rank, g.name, g.id) AS rn
            FROM game_category_game gcg
            JOIN game g ON g.id = gcg.game_id
            WHERE gcg.category_id = ${id} AND gcg.game_id != ALL(${sql.param(gameIds)}::uuid[])
          )
          UPDATE game_category_game AS gcg
          SET position = (${gameIds.length} + unlisted.rn - 1)::int
          FROM unlisted
          WHERE gcg.id = unlisted.id
            AND unlisted.current_position IS DISTINCT FROM (${gameIds.length} + unlisted.rn - 1)::int
        `);
      }
      await tx
        .update(gameCategory)
        .set({
          sortKey: 'manual',
          sortDirection: null,
          sortParams: {},
          ...rankDirtyPatch(),
        })
        .where(eq(gameCategory.id, id));
      const after = [...gameIds, ...unlistedIds];
      return {
        before,
        after,
        sortKeyBefore,
        sortDirectionBefore,
        sortParamsBefore,
      };
    });

    this.events.emit('gaming.category.games_reordered', {
      categoryId: id,
      actorId,
      before: outcome.before,
      after: outcome.after,
      sortKeyBefore: outcome.sortKeyBefore,
      sortKeyAfter: 'manual',
      sortDirectionBefore: outcome.sortDirectionBefore,
      sortDirectionAfter: null,
      sortParamsBefore: outcome.sortParamsBefore,
      sortParamsAfter: {},
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    enqueueGameCategoryRank(this.jobQueue, id);
    return {
      sortKey: 'manual' as const,
      sortDirection: null,
      sortParams: {},
    };
  }

  async updateCategoryPins({
    id,
    pins,
    actorId,
    ip,
    userAgent,
  }: UpdateCategoryPinsInput & CatalogActor) {
    const outcome = await this.drizzle.db.transaction(async (tx) => {
      // The row lock serializes a concurrent pins/reorder/PATCH write on this category -
      // last-write-wins, not optimistic concurrency (docs/modules/gaming.md).
      await this.lockCategoryRow(tx, id);

      const memberRows = await tx
        .select({
          gameId: gameCategoryGame.gameId,
          pinnedPosition: gameCategoryGame.pinnedPosition,
        })
        .from(gameCategoryGame)
        .where(eq(gameCategoryGame.categoryId, id));
      const memberIds = new Set(memberRows.map((row) => row.gameId));
      const missingId = pins.find((pin) => !memberIds.has(pin.gameId))?.gameId;
      if (missingId !== undefined) {
        throw new CategoryGameNotMemberError(missingId, id);
      }

      const before = memberRows
        .filter(
          (row): row is { gameId: string; pinnedPosition: number } => row.pinnedPosition !== null,
        )
        .sort((a, b) => a.pinnedPosition - b.pinnedPosition)
        .map((row) => ({ gameId: row.gameId, position: row.pinnedPosition }));

      // Clears every currently-pinned row first (never the whole category - at most
      // GAME_CATEGORY_PINS_MAX rows): writing the new slots directly could momentarily
      // collide with another game's still-current slot on the partial unique index (a
      // same-request swap in particular) - see docs/modules/gaming.md.
      await tx
        .update(gameCategoryGame)
        .set({ pinnedPosition: null })
        .where(
          and(eq(gameCategoryGame.categoryId, id), isNotNull(gameCategoryGame.pinnedPosition)),
        );

      if (pins.length > 0) {
        await tx.execute(sql`
          UPDATE game_category_game AS gcg
          SET pinned_position = v.position
          FROM (VALUES ${sql.join(
            pins.map((pin) => sql`(${pin.gameId}::uuid, ${pin.position}::int)`),
            sql`, `,
          )}) AS v(game_id, position)
          WHERE gcg.category_id = ${id} AND gcg.game_id = v.game_id
        `);
      }

      await tx.update(gameCategory).set(rankDirtyPatch()).where(eq(gameCategory.id, id));

      const after = [...pins].sort((a, b) => a.position - b.position);
      return { before, after };
    });

    this.events.emit('gaming.category.pins_updated', {
      categoryId: id,
      actorId,
      before: outcome.before,
      after: outcome.after,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    enqueueGameCategoryRank(this.jobQueue, id);
    return { pins: outcome.after };
  }
}

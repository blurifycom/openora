import { eq, inArray } from 'drizzle-orm';
import {
  createDomainError,
  createLogger,
  DrizzleService,
  pageToOffset,
} from '@openora/core/server';
import { GameCategoryRuleClauseSchema, UuidSchema } from '@openora/core/contracts';
import type {
  GameCategoryRule,
  GameCategoryRuleCatalog,
  GameCategoryRuleChange,
  GameCategoryRuleClause,
} from '@openora/core/contracts';
import { game, gameProvider } from '../schema/index.js';
import {
  ADMIN_GAME_RULE_MATCH_MAX,
  GAME_CATEGORY_RULE_MATCH_MAX,
  type GameSearchRuleTooBroadData,
  type PreviewCategoryRuleInput,
} from '../contract/index.js';
import { providerSummaryColumns } from '../../shared/game-catalog.js';
import { paramsJsonSchema } from '../../shared/catalog-options.js';

const logger = createLogger('gaming');

export const GameCategoryRuleInvalidError = createDomainError<[message: string]>(
  'GameCategoryRuleInvalidError',
  (message) => message,
);
export const GameCategoryRuleUnavailableError = createDomainError<[message: string]>(
  'GameCategoryRuleUnavailableError',
  (message) => message,
);
export const GameCategoryRuleTooBroadError = createDomainError<[matchedCount: number]>(
  'GameCategoryRuleTooBroadError',
  (matchedCount) =>
    `The rule matches ${matchedCount} games, exceeding the ${GAME_CATEGORY_RULE_MATCH_MAX}-game cap`,
);

export class GameSearchRuleTooBroadError extends Error {
  readonly data: GameSearchRuleTooBroadData;

  constructor(matchedCount: number) {
    super(
      `The rule filter matches ${matchedCount} games, exceeding the ${ADMIN_GAME_RULE_MATCH_MAX}-game cap`,
    );
    this.name = 'GameSearchRuleTooBroadError';
    this.data = { reason: 'rule_filter_too_broad', matchedCount, max: ADMIN_GAME_RULE_MATCH_MAX };
  }
}

type MatchCap = { max: number; tooBroad: (matchedCount: number) => Error };

export type GameCategoryRuleAuthorizer = (rule: GameCategoryRule) => Promise<void>;

export function isUnresolvableRuleError(err: unknown): err is Error {
  return (
    err instanceof GameCategoryRuleInvalidError || err instanceof GameCategoryRuleTooBroadError
  );
}

export function isRuleAffectedBy(
  catalog: GameCategoryRuleCatalog,
  rule: GameCategoryRule,
  change: GameCategoryRuleChange,
): boolean {
  return rule.some((clause) => {
    const definition = catalog.get(clause.key);
    if (!definition?.isAffectedBy) {
      return false;
    }
    const params = definition.paramsSchema.safeParse(clause.params);
    return params.success && definition.isAffectedBy(params.data, change);
  });
}

export class GameCategoryRuleService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly ruleCatalog: GameCategoryRuleCatalog,
  ) {}

  resolveGameIds(rule: GameCategoryRule, now: Date = new Date()): Promise<string[]> {
    return this.runPipeline(rule, now, {
      max: GAME_CATEGORY_RULE_MATCH_MAX,
      tooBroad: (matchedCount) => new GameCategoryRuleTooBroadError(matchedCount),
    });
  }

  resolveSearchGameIds(rule: GameCategoryRule, now: Date = new Date()): Promise<string[]> {
    return this.runPipeline(rule, now, {
      max: ADMIN_GAME_RULE_MATCH_MAX,
      tooBroad: (matchedCount) => new GameSearchRuleTooBroadError(matchedCount),
    });
  }

  private async runPipeline(rule: GameCategoryRule, now: Date, cap: MatchCap): Promise<string[]> {
    const clauses = rule.map((clause) => this.bindClause(clause));
    let candidateIds: string[] | null = null;
    for (const { definition, params } of clauses) {
      let resolved: unknown;
      try {
        resolved = await definition.resolve({ params, candidateIds, now });
      } catch (err) {
        logger.warn({ err, ruleKey: definition.key }, 'gaming.category.rule: resolve threw');
        throw new GameCategoryRuleUnavailableError(
          `${definition.key}: the rule could not be resolved`,
        );
      }
      if (!Array.isArray(resolved)) {
        throw new GameCategoryRuleInvalidError(
          `${definition.key}: the rule returned no list of game ids`,
        );
      }
      const allowed: ReadonlySet<string> | null = candidateIds ? new Set(candidateIds) : null;
      const ids = resolved
        .filter((id): id is string => UuidSchema.safeParse(id).success)
        .map((id) => id.toLowerCase());
      candidateIds = [...new Set(ids)].filter((id) => allowed === null || allowed.has(id));
      if (candidateIds.length === 0) {
        return [];
      }
      if (candidateIds.length > cap.max) {
        throw cap.tooBroad(candidateIds.length);
      }
    }
    return candidateIds ?? [];
  }

  async normalizeRule(rule: GameCategoryRule): Promise<GameCategoryRule> {
    const normalized: GameCategoryRule = [];
    for (const clause of rule) {
      const { definition, params } = this.bindClause(clause);
      const issue = await this.runValidate(clause.key, () => definition.validate?.(params));
      if (issue) {
        throw new GameCategoryRuleInvalidError(`${clause.key}: ${issue}`);
      }
      const stored = GameCategoryRuleClauseSchema.safeParse({ key: clause.key, params });
      if (!stored.success) {
        throw new GameCategoryRuleInvalidError(`${clause.key}: params must be plain JSON`);
      }
      normalized.push(stored.data);
    }
    return normalized;
  }

  async preview({ rule, page, limit }: PreviewCategoryRuleInput) {
    const matchedIds = await this.resolveGameIds(rule);
    const offset = pageToOffset(page, limit);
    const pageIds = matchedIds.slice(offset, offset + limit);
    const rows =
      pageIds.length > 0
        ? await this.drizzle.db
            .select({
              id: game.id,
              name: game.name,
              slug: game.slug,
              thumbnailUrl: game.thumbnailUrl,
              customThumbnailUrl: game.customThumbnailUrl,
              isActive: game.isActive,
              provider: providerSummaryColumns,
            })
            .from(game)
            .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
            .where(inArray(game.id, pageIds))
        : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      items: pageIds.flatMap((id) => byId.get(id) ?? []),
      total: matchedIds.length,
      page,
      limit,
    };
  }

  isAffectedBy(rule: GameCategoryRule, change: GameCategoryRuleChange): boolean {
    return isRuleAffectedBy(this.ruleCatalog, rule, change);
  }

  exposesReporting(rule: GameCategoryRule): boolean {
    return rule.some((clause) => this.ruleCatalog.get(clause.key)?.exposesReporting === true);
  }

  listRuleOptions() {
    return this.ruleCatalog.list().map((definition) => ({
      key: definition.key,
      exposesReporting: definition.exposesReporting === true,
      paramsJsonSchema: paramsJsonSchema(definition.paramsSchema),
    }));
  }

  private bindClause(clause: GameCategoryRuleClause) {
    const definition = this.ruleCatalog.get(clause.key);
    if (!definition) {
      throw new GameCategoryRuleInvalidError(`Unknown rule key: ${clause.key}`);
    }
    const parsed = definition.paramsSchema.safeParse(clause.params);
    if (!parsed.success) {
      throw new GameCategoryRuleInvalidError(
        `${clause.key}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    return { definition, params: parsed.data };
  }

  private async runValidate(ruleKey: string, validate: () => Promise<string | null> | undefined) {
    try {
      return await validate();
    } catch (err) {
      logger.warn({ err, ruleKey }, 'gaming.category.rule: validate threw');
      throw new GameCategoryRuleUnavailableError(`${ruleKey}: the rule could not be validated`);
    }
  }
}

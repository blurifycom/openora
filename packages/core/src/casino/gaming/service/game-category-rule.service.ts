import { eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
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
import { GAME_CATEGORY_RULE_MATCH_MAX, type PreviewCategoryRuleInput } from '../contract/index.js';
import { providerSummaryColumns } from '../../shared/game-catalog.js';

const logger = createLogger('gaming');

export const GameCategoryRuleInvalidError = createDomainError<[message: string]>(
  'GameCategoryRuleInvalidError',
  (message) => message,
);
export const GameCategoryRuleTooBroadError = createDomainError<[matchedCount: number]>(
  'GameCategoryRuleTooBroadError',
  (matchedCount) =>
    `The rule matches ${matchedCount} games, exceeding the ${GAME_CATEGORY_RULE_MATCH_MAX}-game cap`,
);

/** An error that means the rule itself does not resolve - retrying cannot fix it. */
export function isUnresolvableRuleError(err: unknown): err is Error {
  return (
    err instanceof GameCategoryRuleInvalidError || err instanceof GameCategoryRuleTooBroadError
  );
}

/**
 * True when any clause's definition says `change` could alter what it matches. A clause
 * whose key is unbound, whose params no longer parse, or whose definition declares no
 * `isAffectedBy` never triggers - the periodic sweep covers it.
 */
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

/**
 * Runs rules against GAME_CATEGORY_RULE_CATALOG. Read-only: it answers which games a rule
 * matches and whether a rule may be saved; GameCategoryMembershipService writes the result.
 */
export class GameCategoryRuleService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly ruleCatalog: GameCategoryRuleCatalog,
  ) {}

  /**
   * The games `rule` matches now, in the order its last clause returned them. The first
   * clause sees the whole catalogue (`candidateIds: null`), each later one only what the
   * clause before it left. A definition's result is de-duplicated, stripped of malformed
   * ids and cut down to its candidates, and the match cap applies after every clause.
   */
  async resolveGameIds(rule: GameCategoryRule, now: Date = new Date()): Promise<string[]> {
    const clauses = rule.map((clause) => this.bindClause(clause));
    let candidateIds: string[] | null = null;
    for (const { definition, params } of clauses) {
      let resolved: string[];
      try {
        resolved = await definition.resolve({ params, candidateIds, now });
      } catch (err) {
        logger.warn({ err, ruleKey: definition.key }, 'gaming.category.rule: resolve threw');
        throw new GameCategoryRuleInvalidError(`${definition.key}: the rule could not be resolved`);
      }
      const allowed: ReadonlySet<string> | null = candidateIds ? new Set(candidateIds) : null;
      candidateIds = [...new Set(resolved)].filter(
        (id) => UuidSchema.safeParse(id).success && (allowed === null || allowed.has(id)),
      );
      if (candidateIds.length === 0) {
        return [];
      }
      if (candidateIds.length > GAME_CATEGORY_RULE_MATCH_MAX) {
        throw new GameCategoryRuleTooBroadError(candidateIds.length);
      }
    }
    return candidateIds ?? [];
  }

  /**
   * Checks `rule` for saving and returns it as it will be stored: every key bound, every
   * params object parsed by its definition and still plain JSON, every `validate` passed,
   * and the match within the cap right now.
   */
  async normalizeRule(rule: GameCategoryRule): Promise<GameCategoryRule> {
    const normalized: GameCategoryRule = [];
    for (const clause of rule) {
      const { definition, params } = this.bindClause(clause);
      const issue = await this.runValidate(clause.key, () => definition.validate?.(params));
      if (issue) {
        throw new GameCategoryRuleInvalidError(`${clause.key}: ${issue}`);
      }
      // A paramsSchema may transform, eg a string into a Date, which jsonb cannot hold.
      const stored = GameCategoryRuleClauseSchema.safeParse({ key: clause.key, params });
      if (!stored.success) {
        throw new GameCategoryRuleInvalidError(`${clause.key}: params must be plain JSON`);
      }
      normalized.push(stored.data);
    }
    await this.resolveGameIds(normalized);
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

  /** Whether previewing `rule` shows reporting data; an unbound key counts as no. */
  exposesReporting(rule: GameCategoryRule): boolean {
    return rule.some((clause) => this.ruleCatalog.get(clause.key)?.exposesReporting === true);
  }

  listRuleOptions() {
    return this.ruleCatalog.list().map((definition) => ({
      key: definition.key,
      exposesReporting: definition.exposesReporting === true,
      // Through JSON so the document is exactly what goes over the wire.
      paramsJsonSchema: z
        .json()
        .parse(
          JSON.parse(
            JSON.stringify(z.toJSONSchema(definition.paramsSchema, { unrepresentable: 'any' })),
          ),
        ),
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

  // A throwing `validate` is a rule that cannot be saved, like a throwing `resolve`.
  private async runValidate(ruleKey: string, validate: () => Promise<string | null> | undefined) {
    try {
      return await validate();
    } catch (err) {
      logger.warn({ err, ruleKey }, 'gaming.category.rule: validate threw');
      throw new GameCategoryRuleInvalidError(`${ruleKey}: the rule could not be validated`);
    }
  }
}

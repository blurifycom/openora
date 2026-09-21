import { asc, eq, inArray, sql } from 'drizzle-orm';
import { createLogger, DrizzleService, type EventBus } from '@openora/core/server';
import type { GameCategoryRuleChange, JobQueueAdapter } from '@openora/core/contracts';
import { game, gameCategory, gameTagGame, type GameCategory } from '../schema/index.js';
import {
  GAMES_CREATED_EVENT_BATCH,
  GAME_CATEGORY_MEMBERSHIP_QUEUE,
  MEMBERSHIP_EVENT_DEBOUNCE_MS,
  MEMBERSHIP_SWEEP_BATCH_LIMIT,
  type GameCategoryMembershipJob,
} from '../contract/index.js';
import type { GameCategoryRuleService } from './game-category-rule.service.js';

const logger = createLogger('gaming');

type GameMembershipSnapshot = {
  providerId: string;
  isActive: boolean;
  tagIds: readonly string[];
};

/** What one game update could have moved for a rule, or null when no rule could care. */
export function membershipChangeForGameUpdate(
  before: GameMembershipSnapshot,
  after: GameMembershipSnapshot,
): GameCategoryRuleChange | null {
  const providerChanged = before.providerId !== after.providerId;
  const beforeTags = new Set(before.tagIds);
  const afterTags = new Set(after.tagIds);
  const movedTagIds = [
    ...before.tagIds.filter((id) => !afterTags.has(id)),
    ...after.tagIds.filter((id) => !beforeTags.has(id)),
  ];
  // Playability also depends on the provider being active, which the snapshot does not
  // carry, so a provider move counts as a possible flip.
  const playabilityChanged = before.isActive !== after.isActive || providerChanged;
  if (!providerChanged && movedTagIds.length === 0 && !playabilityChanged) {
    return null;
  }
  return {
    providerIds: providerChanged ? [before.providerId, after.providerId] : [],
    tagIds: movedTagIds,
    playabilityChanged,
  };
}

function mergeChanges(changes: readonly GameCategoryRuleChange[]): GameCategoryRuleChange {
  return {
    providerIds: [...new Set(changes.flatMap((change) => change.providerIds))],
    tagIds: [...new Set(changes.flatMap((change) => change.tagIds))],
    playabilityChanged: changes.some((change) => change.playabilityChanged),
  };
}

/**
 * Decides when a rule-mode category is re-evaluated: a catalogue change reaching one of
 * its clauses, or the periodic sweep. Only queues `gaming.category.membership` jobs - the
 * worker hands them to GameCategoryMembershipService.
 */
export class GameCategoryMembershipTriggerService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly jobQueue: JobQueueAdapter,
    private readonly rules: GameCategoryRuleService,
  ) {}

  private readonly pendingChanges: GameCategoryRuleChange[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * Queues an event-triggered evaluation for every rule-mode category `change` reaches.
   * Changes within `MEMBERSHIP_EVENT_DEBOUNCE_MS` are merged and looked up once, so a
   * burst costs one category scan and one job per category. Per process: the point is
   * to absorb a burst, not to dedupe across replicas.
   */
  enqueueAffected(change: GameCategoryRuleChange): void {
    this.pendingChanges.push(change);
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      const changes = this.pendingChanges.splice(0);
      this.flushTimer = null;
      void this.affectedCategoryIds(mergeChanges(changes))
        .then((categoryIds) => {
          for (const categoryId of categoryIds) {
            this.enqueue(categoryId, 'event');
          }
        })
        .catch((err: unknown) => {
          logger.error({ err }, 'gaming.category.membership: affected-category lookup failed');
        });
    }, MEMBERSHIP_EVENT_DEBOUNCE_MS);
    this.flushTimer.unref();
  }

  /** The rule-mode categories `change` could have moved a game into or out of. */
  async affectedCategoryIds(change: GameCategoryRuleChange): Promise<string[]> {
    const rows = await this.drizzle.db
      .select({ id: gameCategory.id, rule: gameCategory.membershipRule })
      .from(gameCategory)
      .where(eq(gameCategory.membershipMode, 'rule'));
    return rows
      .filter((row) => row.rule && this.rules.isAffectedBy(row.rule, change))
      .map((row) => row.id);
  }

  /** What newly created `gameIds` could have moved: their providers and tags. */
  async changeForGames(gameIds: readonly string[]): Promise<GameCategoryRuleChange> {
    if (gameIds.length === 0) {
      return { providerIds: [], tagIds: [], playabilityChanged: false };
    }
    const [providers, tags] = await Promise.all([
      this.drizzle.db
        .selectDistinct({ id: game.providerId })
        .from(game)
        .where(inArray(game.id, [...gameIds])),
      this.drizzle.db
        .selectDistinct({ id: gameTagGame.tagId })
        .from(gameTagGame)
        .where(inArray(gameTagGame.gameId, [...gameIds])),
    ]);
    return {
      providerIds: providers.map((row) => row.id),
      tagIds: tags.map((row) => row.id),
      playabilityChanged: true,
    };
  }

  /** GAMING_COMMANDS.notifyGamesCreated: announces the ids that really are game rows. */
  async notifyGamesCreated(gameIds: readonly string[]): Promise<void> {
    const uniqueIds = [...new Set(gameIds)];
    for (let start = 0; start < uniqueIds.length; start += GAMES_CREATED_EVENT_BATCH) {
      const rows = await this.drizzle.db
        .select({ id: game.id })
        .from(game)
        .where(inArray(game.id, uniqueIds.slice(start, start + GAMES_CREATED_EVENT_BATCH)));
      if (rows.length > 0) {
        this.events.emit('gaming.games.created', { gameIds: rows.map((row) => row.id) });
      }
    }
  }

  /**
   * Queues a scheduled evaluation for up to `MEMBERSHIP_SWEEP_BATCH_LIMIT` rule-mode
   * categories, least recently attempted first. The only trigger `most_played` has, and
   * the backstop for a lost event or a game inserted without `notifyGamesCreated`.
   */
  async sweep(): Promise<void> {
    const rows = await this.drizzle.db
      .select({ id: gameCategory.id })
      .from(gameCategory)
      .where(eq(gameCategory.membershipMode, 'rule'))
      .orderBy(sql`${gameCategory.membershipAttemptedAt} ASC NULLS FIRST`, asc(gameCategory.id))
      .limit(MEMBERSHIP_SWEEP_BATCH_LIMIT);
    for (const { id } of rows) {
      this.enqueue(id, 'schedule');
    }
  }

  // No idempotencyKey, for the reason enqueueGameCategoryRank gives: a key derived from
  // the category id would dedupe every later trigger against the first completed job.
  private enqueue(categoryId: GameCategory['id'], trigger: GameCategoryMembershipJob['trigger']) {
    this.jobQueue
      .enqueue(GAME_CATEGORY_MEMBERSHIP_QUEUE, { categoryId, trigger })
      .catch((err: unknown) => {
        logger.error({ err, categoryId }, 'gaming.category.membership enqueue failed');
      });
  }
}

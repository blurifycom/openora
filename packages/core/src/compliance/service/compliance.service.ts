import {
  DrizzleService,
  findOneOrThrow,
  type EventBus,
  makeNotFoundError,
  makeOwnershipError,
  serializeRow,
  withAdvisoryXactLock,
} from '@openora/core/server';
import { and, eq } from 'drizzle-orm';
import { geoRule, gameGeoRule } from '../schema/index.js';
import type {
  AddGeoRuleInput,
  DeleteGameGeoRuleInput,
  ListGameGeoRulesInput,
  UpsertGameGeoRuleInput,
} from '../contract/index.js';
import {
  normalizeCountryCode,
  type ClientMeta,
  type GameGeoCheckInput,
  type GeoIpAdapter,
  type User,
} from '@openora/core/contracts';
import { game } from '@openora/core/casino/schema/gaming';

export const LimitNotFoundError = makeNotFoundError('Limit');

export const LimitOwnershipError = makeOwnershipError('Limit');

export const GeoRuleNotFoundError = makeNotFoundError('GeoRule');

export const GameGeoRuleNotFoundError = makeNotFoundError('GameGeoRule');

export const GeoRuleGameNotFoundError = makeNotFoundError('Game');

function gameGeoRuleLockKey(
  gameId: UpsertGameGeoRuleInput['gameId'],
  countryCode: UpsertGameGeoRuleInput['countryCode'],
): string {
  return `game-geo-rule:${gameId}:${countryCode}`;
}

export class ComplianceService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly geoIp: GeoIpAdapter | null,
  ) {}

  async geoCheck(ipAddress: string | null) {
    const rawCountryCode =
      this.geoIp && ipAddress ? (await this.geoIp.lookup(ipAddress)).countryCode : null;
    const countryCode = normalizeCountryCode(rawCountryCode);

    if (!countryCode) {
      // With rules configured, an unresolvable address is a gap in the gate, not a pass.
      const [anyRule] = await this.drizzle.db
        .select({ action: geoRule.action })
        .from(geoRule)
        .limit(1);
      return anyRule
        ? { allowed: false, countryCode: null, reason: 'Geolocation could not be determined' }
        : { allowed: true, countryCode: null, reason: null };
    }

    const [rule] = await this.drizzle.db
      .select({ action: geoRule.action })
      .from(geoRule)
      .where(eq(geoRule.countryCode, countryCode));

    if (rule?.action === 'block') {
      return { allowed: false, countryCode, reason: `Country ${countryCode} is blocked` };
    }

    return { allowed: true, countryCode, reason: null };
  }

  async checkGame(input: GameGeoCheckInput) {
    const rawCountryCode =
      this.geoIp && input.ipAddress ? (await this.geoIp.lookup(input.ipAddress)).countryCode : null;
    const countryCode = normalizeCountryCode(rawCountryCode);

    if (!countryCode) {
      const [gameRule] = await this.drizzle.db
        .select({ id: gameGeoRule.id })
        .from(gameGeoRule)
        .where(eq(gameGeoRule.gameId, input.gameId))
        .limit(1);
      if (gameRule) {
        return { allowed: false as const, countryCode: null, reason: 'geo_unresolved' as const };
      }
      return { allowed: true as const, countryCode: null, reason: null };
    }

    const [globalBlock] = await this.drizzle.db
      .select({ id: geoRule.id })
      .from(geoRule)
      .where(and(eq(geoRule.countryCode, countryCode), eq(geoRule.action, 'block')))
      .limit(1);
    if (globalBlock) {
      return { allowed: false as const, countryCode, reason: 'global_block' as const };
    }

    const [gameBlock] = await this.drizzle.db
      .select({ id: gameGeoRule.id })
      .from(gameGeoRule)
      .where(and(eq(gameGeoRule.gameId, input.gameId), eq(gameGeoRule.countryCode, countryCode)))
      .limit(1);
    if (gameBlock) {
      return { allowed: false as const, countryCode, reason: 'game_block' as const };
    }

    return { allowed: true as const, countryCode, reason: null };
  }

  async checkRegistration(ipAddress: string | null) {
    const result = await this.geoCheck(ipAddress);
    return { allowed: result.allowed };
  }

  async addGeoRule(input: AddGeoRuleInput, actorId?: User['id'], meta?: ClientMeta) {
    const row = findOneOrThrow(
      await this.drizzle.db
        .insert(geoRule)
        .values({ ...input })
        .onConflictDoUpdate({
          target: geoRule.countryCode,
          set: { action: input.action },
        })
        .returning(),
      new GeoRuleNotFoundError(input.countryCode),
    );
    this.events.emit('compliance.geo-rule.added', {
      countryCode: input.countryCode,
      action: input.action,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return serializeRow(row, { dateFields: ['createdAt'] });
  }

  async listGeoRules() {
    const rows = await this.drizzle.db.select().from(geoRule);
    return rows.map((r) => serializeRow(r, { dateFields: ['createdAt'] }));
  }

  async upsertGameGeoRule(input: UpsertGameGeoRuleInput, actorId: User['id'], meta: ClientMeta) {
    const { before, after } = await this.drizzle.db.transaction(async (tx) => {
      findOneOrThrow(
        await tx.select({ id: game.id }).from(game).where(eq(game.id, input.gameId)),
        new GeoRuleGameNotFoundError(input.gameId),
      );

      return withAdvisoryXactLock(
        tx,
        gameGeoRuleLockKey(input.gameId, input.countryCode),
        async () => {
          const [before] = await tx
            .select()
            .from(gameGeoRule)
            .where(
              and(
                eq(gameGeoRule.gameId, input.gameId),
                eq(gameGeoRule.countryCode, input.countryCode),
              ),
            );
          const row = findOneOrThrow(
            await tx
              .insert(gameGeoRule)
              .values(input)
              .onConflictDoUpdate({
                target: [gameGeoRule.gameId, gameGeoRule.countryCode],
                set: { reason: input.reason, updatedAt: new Date() },
              })
              .returning(),
            new GameGeoRuleNotFoundError(`${input.gameId}:${input.countryCode}`),
          );
          return {
            before: before
              ? serializeRow(before, { dateFields: ['createdAt', 'updatedAt'] })
              : null,
            after: serializeRow(row, { dateFields: ['createdAt', 'updatedAt'] }),
          };
        },
      );
    });

    this.events.emit('compliance.game-geo-rule.upserted', {
      ruleId: after.id,
      gameId: input.gameId,
      countryCode: input.countryCode,
      reason: input.reason,
      before,
      after,
      actorId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return after;
  }

  async deleteGameGeoRule(input: DeleteGameGeoRuleInput, actorId: User['id'], meta: ClientMeta) {
    const before = await this.drizzle.db.transaction(async (tx) => {
      const existing = findOneOrThrow(
        await tx
          .select({ gameId: gameGeoRule.gameId, countryCode: gameGeoRule.countryCode })
          .from(gameGeoRule)
          .where(eq(gameGeoRule.id, input.id)),
        new GameGeoRuleNotFoundError(input.id),
      );

      return withAdvisoryXactLock(
        tx,
        gameGeoRuleLockKey(existing.gameId, existing.countryCode),
        async () => {
          const row = findOneOrThrow(
            await tx.delete(gameGeoRule).where(eq(gameGeoRule.id, input.id)).returning(),
            new GameGeoRuleNotFoundError(input.id),
          );
          return serializeRow(row, { dateFields: ['createdAt', 'updatedAt'] });
        },
      );
    });

    this.events.emit('compliance.game-geo-rule.deleted', {
      ruleId: before.id,
      gameId: before.gameId,
      countryCode: before.countryCode,
      reason: input.reason,
      before,
      after: null,
      actorId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return before;
  }

  async listGameGeoRules(input: ListGameGeoRulesInput) {
    const rows = input.gameId
      ? await this.drizzle.db.select().from(gameGeoRule).where(eq(gameGeoRule.gameId, input.gameId))
      : await this.drizzle.db.select().from(gameGeoRule);
    return rows.map((row) => serializeRow(row, { dateFields: ['createdAt', 'updatedAt'] }));
  }
}

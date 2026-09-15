import {
  DrizzleService,
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  makeOwnershipError,
  serializeRow,
  withAdvisoryXactLock,
  type EventBus,
} from '@openora/core/server';
import { and, eq, exists, sql } from 'drizzle-orm';
import {
  countryRule,
  gameGeoRule,
  globalKycConfig,
  GLOBAL_KYC_ENABLED_DEFAULT,
  providerGeoRule,
} from '../schema/index.js';
import type {
  AddGeoRuleInput,
  DeleteGameGeoRuleInput,
  DeleteProviderGeoRuleInput,
  ListGameGeoRulesInput,
  ListProviderGeoRulesInput,
  SetGlobalKycConfigInput,
  UpsertCountryRuleInput,
  UpsertGameGeoRuleInput,
  UpsertProviderGeoRuleInput,
} from '../contract/index.js';
import {
  normalizeCountryCode,
  type AuditWritePort,
  type ClientMeta,
  type GameGeoCheckInput,
  type GeoIpAdapter,
  type GeoRuleAction,
  type IgamingConfig,
  type User,
} from '@openora/core/contracts';
import { game, gameProvider } from '@openora/core/casino/schema/gaming';

export const LimitNotFoundError = makeNotFoundError('Limit');

export const LimitOwnershipError = makeOwnershipError('Limit');

export const CountryRuleNotFoundError = makeNotFoundError('CountryRule');

export const GlobalKycConfigNotFoundError = makeNotFoundError('GlobalKycConfig');

export const CountryRuleVersionConflictError = makeConflictError(
  'CountryRuleVersionConflictError',
  'Country rule has changed. Refresh and try again.',
  { reason: 'stale_version' },
);

export const GlobalKycConfigVersionConflictError = makeConflictError(
  'GlobalKycConfigVersionConflictError',
  'Global KYC configuration has changed. Refresh and try again.',
  { reason: 'stale_version' },
);

export const LicensedJurisdictionBlacklistError = makeConflictError(
  'LicensedJurisdictionBlacklistError',
  'A licensed jurisdiction cannot be blacklisted.',
  { reason: 'licensed_jurisdiction' },
);

export const CountryRuleConfirmationRequiredError = makeConflictError(
  'CountryRuleConfirmationRequiredError',
  'Confirmation is required to change a country rule.',
  { reason: 'confirmation_required' },
);

const COUNTRY_RULE_FIELDS = ['blacklisted', 'redirectIp', 'kycRequired'] as const;

function hasCountryRuleChanges(
  before: typeof countryRule.$inferSelect,
  input: UpsertCountryRuleInput,
) {
  return COUNTRY_RULE_FIELDS.some((field) => countryRuleFieldValue(before, field) !== input[field]);
}

function weakensCountryRule(
  before: typeof countryRule.$inferSelect,
  input: UpsertCountryRuleInput,
) {
  return (
    (before.action === 'block' && !input.blacklisted) ||
    (before.redirectIp && !input.redirectIp) ||
    (before.kycRequired && !input.kycRequired)
  );
}

function countryRuleFieldValue(
  row: typeof countryRule.$inferSelect,
  field: (typeof COUNTRY_RULE_FIELDS)[number],
) {
  return field === 'blacklisted' ? row.action === 'block' : row[field];
}

function hasExpectedVersion(actual: Date | null, expected: string | null) {
  return (actual ? actual.toISOString() : null) === expected;
}

function toCountryRuleView(row: typeof countryRule.$inferSelect) {
  return {
    id: row.id,
    countryCode: row.countryCode,
    blacklisted: row.action === 'block',
    redirectIp: row.redirectIp,
    kycRequired: row.kycRequired,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    updatedBy: row.updatedBy,
  };
}

function toGlobalKycConfigView(row: typeof globalKycConfig.$inferSelect) {
  return {
    enabled: row.enabled,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    updatedBy: row.updatedBy,
  };
}

function toGeoRuleView(row: typeof countryRule.$inferSelect) {
  return {
    id: row.id,
    countryCode: row.countryCode,
    action: row.action as GeoRuleAction,
    createdAt: row.createdAt.toISOString(),
  };
}

export const GameGeoRuleNotFoundError = makeNotFoundError('GameGeoRule');

export const GeoRuleGameNotFoundError = makeNotFoundError('Game');

function gameGeoRuleLockKey(
  gameId: UpsertGameGeoRuleInput['gameId'],
  countryCode: UpsertGameGeoRuleInput['countryCode'],
): string {
  return `game-geo-rule:${gameId}:${countryCode}`;
}

export const ProviderGeoRuleNotFoundError = makeNotFoundError('ProviderGeoRule');

export const GeoRuleProviderNotFoundError = makeNotFoundError('GameProvider');

function providerGeoRuleLockKey(
  providerId: UpsertProviderGeoRuleInput['providerId'],
  countryCode: UpsertProviderGeoRuleInput['countryCode'],
): string {
  return `provider-geo-rule:${providerId}:${countryCode}`;
}

export class ComplianceService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly geoIp: GeoIpAdapter | null,
    private readonly audit: AuditWritePort,
    private readonly igaming: IgamingConfig | null = null,
  ) {}

  async geoCheck(ipAddress: string | null) {
    if (!this.geoIp) {
      return { allowed: true, countryCode: null, reason: null };
    }

    const countryCode = normalizeCountryCode(
      ipAddress ? (await this.geoIp.lookup(ipAddress)).countryCode : null,
    );

    if (!countryCode) {
      const [blacklistedRule] = await this.drizzle.db
        .select({ countryCode: countryRule.countryCode })
        .from(countryRule)
        .where(eq(countryRule.action, 'block'))
        .limit(1);
      return blacklistedRule || this.igaming?.blockedCountries.length
        ? { allowed: false, countryCode: null, reason: 'Geolocation could not be determined' }
        : { allowed: true, countryCode: null, reason: null };
    }

    if (this.igaming?.blockedCountries.includes(countryCode)) {
      return { allowed: false, countryCode, reason: `Country ${countryCode} is blocked` };
    }

    const [rule] = await this.drizzle.db
      .select({ action: countryRule.action })
      .from(countryRule)
      .where(eq(countryRule.countryCode, countryCode));

    if (rule?.action === 'block') {
      return { allowed: false, countryCode, reason: `Country ${countryCode} is blocked` };
    }

    return { allowed: true, countryCode, reason: null };
  }

  async checkGame(input: GameGeoCheckInput) {
    const globalDecision = await this.geoCheck(input.ipAddress);
    if (!globalDecision.allowed) {
      return {
        allowed: false as const,
        countryCode: globalDecision.countryCode,
        reason: globalDecision.countryCode
          ? ('global_block' as const)
          : ('geo_unresolved' as const),
      };
    }

    const { countryCode } = globalDecision;
    // Without a resolved country any rule counts, so an unresolved lookup fails closed.
    const [rules] = await this.drizzle.db
      .select({
        providerRule: sql<boolean>`${exists(
          this.drizzle.db
            .select({ id: providerGeoRule.id })
            .from(providerGeoRule)
            .where(
              and(
                eq(providerGeoRule.providerId, game.providerId),
                countryCode ? eq(providerGeoRule.countryCode, countryCode) : undefined,
              ),
            ),
        )}`,
        gameRule: sql<boolean>`${exists(
          this.drizzle.db
            .select({ id: gameGeoRule.id })
            .from(gameGeoRule)
            .where(
              and(
                eq(gameGeoRule.gameId, game.id),
                countryCode ? eq(gameGeoRule.countryCode, countryCode) : undefined,
              ),
            ),
        )}`,
      })
      .from(game)
      .where(eq(game.id, input.gameId));

    if (!rules) {
      return { allowed: false as const, countryCode, reason: 'game_not_found' as const };
    }
    if (!countryCode) {
      return rules.providerRule || rules.gameRule
        ? { allowed: false as const, countryCode: null, reason: 'geo_unresolved' as const }
        : { allowed: true as const, countryCode: null, reason: null };
    }
    if (rules.providerRule) {
      return { allowed: false as const, countryCode, reason: 'provider_block' as const };
    }
    if (rules.gameRule) {
      return { allowed: false as const, countryCode, reason: 'game_block' as const };
    }

    return { allowed: true as const, countryCode, reason: null };
  }

  async checkRegistration(ipAddress: string | null) {
    const result = await this.geoCheck(ipAddress);
    return { allowed: result.allowed };
  }

  async upsertCountryRule(input: UpsertCountryRuleInput, actorId: User['id'], meta?: ClientMeta) {
    return this.drizzle.db.transaction(async (tx) => {
      if (input.blacklisted && this.igaming?.jurisdictions.includes(input.countryCode)) {
        throw new LicensedJurisdictionBlacklistError();
      }

      const [inserted] = await tx
        .insert(countryRule)
        .values({ countryCode: input.countryCode, action: 'allow' })
        .onConflictDoNothing()
        .returning();
      const before =
        inserted ??
        findOneOrThrow(
          await tx
            .select()
            .from(countryRule)
            .where(eq(countryRule.countryCode, input.countryCode))
            .for('update'),
          new CountryRuleNotFoundError(input.countryCode),
        );

      if (!hasExpectedVersion(before.updatedAt, input.expectedUpdatedAt)) {
        throw new CountryRuleVersionConflictError();
      }
      if (
        ((before.action !== 'block' && input.blacklisted) || weakensCountryRule(before, input)) &&
        !input.confirm
      ) {
        throw new CountryRuleConfirmationRequiredError();
      }
      if (!hasCountryRuleChanges(before, input)) {
        if (inserted) {
          const row = findOneOrThrow(
            await tx
              .update(countryRule)
              .set({ updatedAt: new Date(), updatedBy: actorId })
              .where(eq(countryRule.id, before.id))
              .returning(),
            new CountryRuleNotFoundError(input.countryCode),
          );
          await this.audit.recordInTransaction(tx, {
            actorId,
            actorType: 'admin',
            action: 'compliance.country_rule.created',
            resourceType: 'country-rule',
            resourceId: input.countryCode,
            before: null,
            after: {
              blacklisted: false,
              redirectIp: false,
              kycRequired: true,
            },
            ...meta,
          });
          return toCountryRuleView(row);
        }
        return toCountryRuleView(before);
      }

      const row = findOneOrThrow(
        await tx
          .update(countryRule)
          .set({
            action: input.blacklisted ? 'block' : 'allow',
            redirectIp: input.redirectIp,
            kycRequired: input.kycRequired,
            updatedAt: new Date(),
            updatedBy: actorId,
          })
          .where(eq(countryRule.id, before.id))
          .returning(),
        new CountryRuleNotFoundError(input.countryCode),
      );

      for (const field of COUNTRY_RULE_FIELDS) {
        if (countryRuleFieldValue(before, field) === countryRuleFieldValue(row, field)) {
          continue;
        }
        await this.audit.recordInTransaction(tx, {
          actorId,
          actorType: 'admin',
          action: 'compliance.country_rule.setting_changed',
          resourceType: 'country-rule',
          resourceId: input.countryCode,
          before: { setting: field, value: countryRuleFieldValue(before, field) },
          after: { setting: field, value: countryRuleFieldValue(row, field) },
          ...meta,
        });
      }

      return toCountryRuleView(row);
    });
  }

  async listCountryRules() {
    const rows = await this.drizzle.db.select().from(countryRule);
    return rows.map(toCountryRuleView);
  }

  async getGlobalKycConfig() {
    const [row] = await this.drizzle.db
      .select()
      .from(globalKycConfig)
      .where(eq(globalKycConfig.singletonKey, 'global'));
    return row
      ? toGlobalKycConfigView(row)
      : { enabled: GLOBAL_KYC_ENABLED_DEFAULT, updatedAt: null, updatedBy: null };
  }

  async setGlobalKycConfig(input: SetGlobalKycConfigInput, actorId: User['id'], meta?: ClientMeta) {
    return this.drizzle.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(globalKycConfig)
        .values({ singletonKey: 'global' })
        .onConflictDoNothing()
        .returning();
      const before =
        inserted ??
        findOneOrThrow(
          await tx
            .select()
            .from(globalKycConfig)
            .where(eq(globalKycConfig.singletonKey, 'global'))
            .for('update'),
          new GlobalKycConfigNotFoundError('global'),
        );

      if (!hasExpectedVersion(before.updatedAt, input.expectedUpdatedAt)) {
        throw new GlobalKycConfigVersionConflictError();
      }
      if (before.enabled === input.enabled) {
        return toGlobalKycConfigView(before);
      }

      const row = findOneOrThrow(
        await tx
          .update(globalKycConfig)
          .set({ enabled: input.enabled, updatedAt: new Date(), updatedBy: actorId })
          .where(eq(globalKycConfig.id, before.id))
          .returning(),
        new GlobalKycConfigNotFoundError('global'),
      );

      await this.audit.recordInTransaction(tx, {
        actorId,
        actorType: 'admin',
        action: 'compliance.global_kyc.set',
        resourceType: 'global-kyc-config',
        resourceId: 'global',
        before: { enabled: before.enabled },
        after: { enabled: row.enabled },
        ...meta,
      });

      return toGlobalKycConfigView(row);
    });
  }

  async addGeoRule(input: AddGeoRuleInput, actorId: User['id'], meta?: ClientMeta) {
    const [existing] = await this.drizzle.db
      .select()
      .from(countryRule)
      .where(eq(countryRule.countryCode, input.countryCode));
    const blacklisted = input.action === 'block';
    const rule = await this.upsertCountryRule(
      {
        countryCode: input.countryCode,
        blacklisted,
        redirectIp: existing?.redirectIp ?? false,
        kycRequired: existing?.kycRequired ?? true,
        expectedUpdatedAt: existing?.updatedAt?.toISOString() ?? null,
        confirm: input.confirm ?? true,
      },
      actorId,
      meta,
    );

    if ((existing?.action === 'block') !== blacklisted) {
      this.events.emit('compliance.geo-rule.added', {
        countryCode: input.countryCode,
        action: input.action,
        actorId,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    }
    return {
      id: rule.id,
      countryCode: rule.countryCode,
      action: (rule.blacklisted ? 'block' : 'allow') as GeoRuleAction,
      createdAt: rule.createdAt,
    };
  }

  async listGeoRules() {
    const rows = await this.drizzle.db.select().from(countryRule);
    return rows.map(toGeoRuleView);
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

  async upsertProviderGeoRule(
    input: UpsertProviderGeoRuleInput,
    actorId: User['id'],
    meta: ClientMeta,
  ) {
    const { before, after } = await this.drizzle.db.transaction(async (tx) => {
      findOneOrThrow(
        await tx
          .select({ id: gameProvider.id })
          .from(gameProvider)
          .where(eq(gameProvider.id, input.providerId)),
        new GeoRuleProviderNotFoundError(input.providerId),
      );

      return withAdvisoryXactLock(
        tx,
        providerGeoRuleLockKey(input.providerId, input.countryCode),
        async () => {
          const [before] = await tx
            .select()
            .from(providerGeoRule)
            .where(
              and(
                eq(providerGeoRule.providerId, input.providerId),
                eq(providerGeoRule.countryCode, input.countryCode),
              ),
            );
          const row = findOneOrThrow(
            await tx
              .insert(providerGeoRule)
              .values(input)
              .onConflictDoUpdate({
                target: [providerGeoRule.providerId, providerGeoRule.countryCode],
                set: { reason: input.reason, updatedAt: new Date() },
              })
              .returning(),
            new ProviderGeoRuleNotFoundError(`${input.providerId}:${input.countryCode}`),
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

    this.events.emit('compliance.provider-geo-rule.upserted', {
      ruleId: after.id,
      providerId: input.providerId,
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

  async deleteProviderGeoRule(
    input: DeleteProviderGeoRuleInput,
    actorId: User['id'],
    meta: ClientMeta,
  ) {
    const before = await this.drizzle.db.transaction(async (tx) => {
      const existing = findOneOrThrow(
        await tx
          .select({
            providerId: providerGeoRule.providerId,
            countryCode: providerGeoRule.countryCode,
          })
          .from(providerGeoRule)
          .where(eq(providerGeoRule.id, input.id)),
        new ProviderGeoRuleNotFoundError(input.id),
      );

      return withAdvisoryXactLock(
        tx,
        providerGeoRuleLockKey(existing.providerId, existing.countryCode),
        async () => {
          const row = findOneOrThrow(
            await tx.delete(providerGeoRule).where(eq(providerGeoRule.id, input.id)).returning(),
            new ProviderGeoRuleNotFoundError(input.id),
          );
          return serializeRow(row, { dateFields: ['createdAt', 'updatedAt'] });
        },
      );
    });

    this.events.emit('compliance.provider-geo-rule.deleted', {
      ruleId: before.id,
      providerId: before.providerId,
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

  async listProviderGeoRules(input: ListProviderGeoRulesInput) {
    const rows = input.providerId
      ? await this.drizzle.db
          .select()
          .from(providerGeoRule)
          .where(eq(providerGeoRule.providerId, input.providerId))
      : await this.drizzle.db.select().from(providerGeoRule);
    return rows.map((row) => serializeRow(row, { dateFields: ['createdAt', 'updatedAt'] }));
  }
}

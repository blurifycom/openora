import {
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
  makeConflictError,
  makeNotFoundError,
  makeOwnershipError,
  serializeRow,
  withAdvisoryXactLocks,
  type EventBus,
} from '@openora/core/server';
import { and, asc, count, eq, exists, inArray, sql } from 'drizzle-orm';
import {
  countryRule,
  gameGeoRule,
  globalKycConfig,
  GLOBAL_KYC_ENABLED_DEFAULT,
  providerGeoRule,
} from '../schema/index.js';
import type {
  AddGeoRuleInput,
  DeleteGameGeoRulesInput,
  DeleteProviderGeoRulesInput,
  UpsertGameGeoRulesInput,
  UpsertProviderGeoRulesInput,
  ListGameGeoRulesInput,
  ListProviderGeoRulesInput,
  SetGlobalKycConfigInput,
  UpsertCountryRuleInput,
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
  gameId: UpsertGameGeoRulesInput['gameId'],
  countryCode: UpsertGameGeoRulesInput['countryCodes'][number],
): string {
  return `game-geo-rule:${gameId}:${countryCode}`;
}

export const ProviderGeoRuleNotFoundError = makeNotFoundError('ProviderGeoRule');

export const GeoRuleProviderNotFoundError = makeNotFoundError('GameProvider');

function providerGeoRuleLockKey(
  providerId: UpsertProviderGeoRulesInput['providerId'],
  countryCode: UpsertProviderGeoRulesInput['countryCodes'][number],
): string {
  return `provider-geo-rule:${providerId}:${countryCode}`;
}

function missingCountryCodes(requested: string[], rows: { countryCode: string }[]) {
  const found = new Set(rows.map((row) => row.countryCode));
  return requested.filter((countryCode) => !found.has(countryCode));
}

function serializeGeoRule<Rule extends { createdAt: Date; updatedAt: Date }>(rule: Rule) {
  return serializeRow(rule, { dateFields: ['createdAt', 'updatedAt'] });
}

function pairGeoRuleChanges<Rule extends { countryCode: string; createdAt: Date; updatedAt: Date }>(
  before: Rule[],
  after: Rule[],
) {
  const beforeByCountry = new Map(before.map((row) => [row.countryCode, serializeGeoRule(row)]));
  return after
    .map((row) => ({
      before: beforeByCountry.get(row.countryCode) ?? null,
      after: serializeGeoRule(row),
    }))
    .sort((a, b) => a.after.countryCode.localeCompare(b.after.countryCode));
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
    const matchesCountry = (
      column: typeof providerGeoRule.countryCode | typeof gameGeoRule.countryCode,
    ) => (countryCode ? eq(column, countryCode) : undefined);
    const [rules] = await this.drizzle.db
      .select({
        providerRule: sql<boolean>`${exists(
          this.drizzle.db
            .select({ id: providerGeoRule.id })
            .from(providerGeoRule)
            .where(
              and(
                eq(providerGeoRule.providerId, game.providerId),
                matchesCountry(providerGeoRule.countryCode),
              ),
            ),
        )}`,
        gameRule: sql<boolean>`${exists(
          this.drizzle.db
            .select({ id: gameGeoRule.id })
            .from(gameGeoRule)
            .where(and(eq(gameGeoRule.gameId, game.id), matchesCountry(gameGeoRule.countryCode))),
        )}`,
      })
      .from(game)
      .where(eq(game.id, input.gameId));

    if (!rules) {
      return { allowed: false as const, countryCode: null, reason: 'game_not_found' as const };
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
    return { allowed: result.allowed, countryCode: result.countryCode };
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

  /**
   * The effective KYC requirement for a player, combining the global switch with the
   * per-country exemption list. Fail-closed on every "we don't actually know" branch:
   * an unresolved country is treated as requiring KYC, and a country with no rule row
   * defaults to `kycRequired: true` (the same default `countryRule.kycRequired` carries
   * in the schema).
   */
  async resolveKycRequirement(countryCode: string | null): Promise<{
    required: boolean;
    reason: 'global_disabled' | 'country_exempt' | 'required' | 'country_unknown';
  }> {
    const global = await this.getGlobalKycConfig();
    if (!global.enabled) {
      return { required: false, reason: 'global_disabled' };
    }

    const normalized = normalizeCountryCode(countryCode);
    if (!normalized) {
      return { required: true, reason: 'country_unknown' };
    }

    const [rule] = await this.drizzle.db
      .select({ kycRequired: countryRule.kycRequired })
      .from(countryRule)
      .where(eq(countryRule.countryCode, normalized));

    if (rule && !rule.kycRequired) {
      return { required: false, reason: 'country_exempt' };
    }
    return { required: true, reason: 'required' };
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

  async upsertGameGeoRules(input: UpsertGameGeoRulesInput, actorId: User['id'], meta: ClientMeta) {
    const countryCodes = [...new Set(input.countryCodes)].sort();
    const changes = await this.drizzle.db.transaction(async (tx) => {
      findOneOrThrow(
        await tx.select({ id: game.id }).from(game).where(eq(game.id, input.gameId)),
        new GeoRuleGameNotFoundError(input.gameId),
      );

      return withAdvisoryXactLocks(
        tx,
        countryCodes.map((countryCode) => gameGeoRuleLockKey(input.gameId, countryCode)),
        async () => {
          const before = await tx
            .select()
            .from(gameGeoRule)
            .where(
              and(
                eq(gameGeoRule.gameId, input.gameId),
                inArray(gameGeoRule.countryCode, countryCodes),
              ),
            );
          const rows = await tx
            .insert(gameGeoRule)
            .values(
              countryCodes.map((countryCode) => ({
                gameId: input.gameId,
                countryCode,
                reason: input.reason,
              })),
            )
            .onConflictDoUpdate({
              target: [gameGeoRule.gameId, gameGeoRule.countryCode],
              set: { reason: input.reason, updatedAt: new Date() },
            })
            .returning();
          return pairGeoRuleChanges(before, rows);
        },
      );
    });

    for (const { before, after } of changes) {
      this.events.emit('compliance.game-geo-rule.upserted', {
        ruleId: after.id,
        gameId: input.gameId,
        countryCode: after.countryCode,
        reason: input.reason,
        before,
        after,
        actorId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return changes.map(({ after }) => after);
  }

  async deleteGameGeoRules(input: DeleteGameGeoRulesInput, actorId: User['id'], meta: ClientMeta) {
    const countryCodes = [...new Set(input.countryCodes)].sort();
    const deleted = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLocks(
        tx,
        countryCodes.map((countryCode) => gameGeoRuleLockKey(input.gameId, countryCode)),
        async () => {
          const rows = await tx
            .delete(gameGeoRule)
            .where(
              and(
                eq(gameGeoRule.gameId, input.gameId),
                inArray(gameGeoRule.countryCode, countryCodes),
              ),
            )
            .returning();
          const missing = missingCountryCodes(countryCodes, rows);
          if (missing.length > 0) {
            throw new GameGeoRuleNotFoundError(`${input.gameId}:${missing.join(',')}`);
          }
          return rows
            .map(serializeGeoRule)
            .sort((a, b) => a.countryCode.localeCompare(b.countryCode));
        },
      ),
    );

    for (const before of deleted) {
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
    }
    return deleted;
  }

  async listGameGeoRules({ gameIds, page, limit }: ListGameGeoRulesInput) {
    const where = gameIds ? inArray(gameGeoRule.gameId, gameIds) : undefined;
    const db = this.drizzle.db;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select()
        .from(gameGeoRule)
        .where(where)
        .orderBy(asc(gameGeoRule.gameId), asc(gameGeoRule.countryCode))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(gameGeoRule).where(where),
    ]);
    return { items: rows.map(serializeGeoRule), total: Number(n), page, limit };
  }

  async upsertProviderGeoRules(
    input: UpsertProviderGeoRulesInput,
    actorId: User['id'],
    meta: ClientMeta,
  ) {
    const countryCodes = [...new Set(input.countryCodes)].sort();
    const changes = await this.drizzle.db.transaction(async (tx) => {
      findOneOrThrow(
        await tx
          .select({ id: gameProvider.id })
          .from(gameProvider)
          .where(eq(gameProvider.id, input.providerId)),
        new GeoRuleProviderNotFoundError(input.providerId),
      );

      return withAdvisoryXactLocks(
        tx,
        countryCodes.map((countryCode) => providerGeoRuleLockKey(input.providerId, countryCode)),
        async () => {
          const before = await tx
            .select()
            .from(providerGeoRule)
            .where(
              and(
                eq(providerGeoRule.providerId, input.providerId),
                inArray(providerGeoRule.countryCode, countryCodes),
              ),
            );
          const rows = await tx
            .insert(providerGeoRule)
            .values(
              countryCodes.map((countryCode) => ({
                providerId: input.providerId,
                countryCode,
                reason: input.reason,
              })),
            )
            .onConflictDoUpdate({
              target: [providerGeoRule.providerId, providerGeoRule.countryCode],
              set: { reason: input.reason, updatedAt: new Date() },
            })
            .returning();
          return pairGeoRuleChanges(before, rows);
        },
      );
    });

    for (const { before, after } of changes) {
      this.events.emit('compliance.provider-geo-rule.upserted', {
        ruleId: after.id,
        providerId: input.providerId,
        countryCode: after.countryCode,
        reason: input.reason,
        before,
        after,
        actorId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return changes.map(({ after }) => after);
  }

  async deleteProviderGeoRules(
    input: DeleteProviderGeoRulesInput,
    actorId: User['id'],
    meta: ClientMeta,
  ) {
    const countryCodes = [...new Set(input.countryCodes)].sort();
    const deleted = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLocks(
        tx,
        countryCodes.map((countryCode) => providerGeoRuleLockKey(input.providerId, countryCode)),
        async () => {
          const rows = await tx
            .delete(providerGeoRule)
            .where(
              and(
                eq(providerGeoRule.providerId, input.providerId),
                inArray(providerGeoRule.countryCode, countryCodes),
              ),
            )
            .returning();
          const missing = missingCountryCodes(countryCodes, rows);
          if (missing.length > 0) {
            throw new ProviderGeoRuleNotFoundError(`${input.providerId}:${missing.join(',')}`);
          }
          return rows
            .map(serializeGeoRule)
            .sort((a, b) => a.countryCode.localeCompare(b.countryCode));
        },
      ),
    );

    for (const before of deleted) {
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
    }
    return deleted;
  }

  async listProviderGeoRules({ providerIds, page, limit }: ListProviderGeoRulesInput) {
    const where = providerIds ? inArray(providerGeoRule.providerId, providerIds) : undefined;
    const db = this.drizzle.db;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select()
        .from(providerGeoRule)
        .where(where)
        .orderBy(asc(providerGeoRule.providerId), asc(providerGeoRule.countryCode))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(providerGeoRule).where(where),
    ]);
    return { items: rows.map(serializeGeoRule), total: Number(n), page, limit };
  }
}

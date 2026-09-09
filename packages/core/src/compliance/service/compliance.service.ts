import {
  DrizzleService,
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  makeOwnershipError,
  serializeRow,
  type EventBus,
} from '@openora/core/server';
import { eq } from 'drizzle-orm';
import { countryRule, globalKycConfig, GLOBAL_KYC_ENABLED_DEFAULT } from '../schema/index.js';
import type {
  AddGeoRuleInput,
  SetGlobalKycConfigInput,
  UpsertCountryRuleInput,
} from '../contract/index.js';
import type {
  AuditWritePort,
  ClientMeta,
  GeoIpAdapter,
  GeoRuleAction,
  IgamingConfig,
  User,
} from '@openora/core/contracts';

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
  'Confirmation is required to weaken a country rule.',
  { reason: 'confirmation_required' },
);

const COUNTRY_RULE_FIELDS = ['blacklisted', 'redirectIp', 'kycRequired'] as const;

function hasCountryRuleChanges(
  before: typeof countryRule.$inferSelect,
  input: UpsertCountryRuleInput,
) {
  return COUNTRY_RULE_FIELDS.some((field) => before[field] !== input[field]);
}

function weakensCountryRule(
  before: typeof countryRule.$inferSelect,
  input: UpsertCountryRuleInput,
) {
  return (
    (before.blacklisted && !input.blacklisted) ||
    (before.redirectIp && !input.redirectIp) ||
    (before.kycRequired && !input.kycRequired)
  );
}

function hasExpectedVersion(actual: Date | null, expected: string | null) {
  return (actual ? actual.toISOString() : null) === expected;
}

function toCountryRuleView(row: typeof countryRule.$inferSelect) {
  return serializeRow(row, { dateFields: ['createdAt', 'updatedAt'] });
}

function toGlobalKycConfigView(row: typeof globalKycConfig.$inferSelect) {
  return {
    enabled: row.enabled,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    updatedBy: row.updatedBy,
  };
}

function toGeoRuleView(row: typeof countryRule.$inferSelect) {
  const action: GeoRuleAction = row.blacklisted ? 'block' : 'allow';
  return {
    id: row.id,
    countryCode: row.countryCode,
    action,
    createdAt: row.createdAt.toISOString(),
  };
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
    const countryCode =
      this.geoIp && ipAddress ? (await this.geoIp.lookup(ipAddress)).countryCode : null;

    if (!countryCode) {
      const [blacklistedRule] = await this.drizzle.db
        .select({ countryCode: countryRule.countryCode })
        .from(countryRule)
        .where(eq(countryRule.blacklisted, true))
        .limit(1);
      return blacklistedRule || this.igaming?.blockedCountries.length
        ? { allowed: false, countryCode: null, reason: 'Geolocation could not be determined' }
        : { allowed: true, countryCode: null, reason: null };
    }

    if (this.igaming?.blockedCountries.includes(countryCode)) {
      return { allowed: false, countryCode, reason: `Country ${countryCode} is blocked` };
    }

    const [rule] = await this.drizzle.db
      .select({ blacklisted: countryRule.blacklisted })
      .from(countryRule)
      .where(eq(countryRule.countryCode, countryCode));

    if (rule?.blacklisted) {
      return { allowed: false, countryCode, reason: `Country ${countryCode} is blocked` };
    }

    return { allowed: true, countryCode, reason: null };
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
        .values({ countryCode: input.countryCode })
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
      if (weakensCountryRule(before, input) && !input.confirm) {
        throw new CountryRuleConfirmationRequiredError();
      }
      if (!hasCountryRuleChanges(before, input)) {
        return toCountryRuleView(before);
      }

      const row = findOneOrThrow(
        await tx
          .update(countryRule)
          .set({
            blacklisted: input.blacklisted,
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
        if (before[field] === row[field]) {
          continue;
        }
        await this.audit.recordInTransaction(tx, {
          actorId,
          actorType: 'admin',
          action: 'compliance.country_rule.setting_changed',
          resourceType: 'country-rule',
          resourceId: input.countryCode,
          before: { setting: field, value: before[field] },
          after: { setting: field, value: row[field] },
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

  async addGeoRule(input: AddGeoRuleInput, actorId?: User['id'], meta?: ClientMeta) {
    if (input.action === 'block' && this.igaming?.jurisdictions.includes(input.countryCode)) {
      throw new LicensedJurisdictionBlacklistError();
    }

    const row = await this.drizzle.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(countryRule)
        .values({ countryCode: input.countryCode })
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
      const blacklisted = input.action === 'block';
      const row =
        before.blacklisted === blacklisted
          ? before
          : findOneOrThrow(
              await tx
                .update(countryRule)
                .set({ blacklisted, updatedAt: new Date(), updatedBy: actorId ?? null })
                .where(eq(countryRule.id, before.id))
                .returning(),
              new CountryRuleNotFoundError(input.countryCode),
            );

      return toGeoRuleView(row);
    });
    this.events.emit('compliance.geo-rule.added', {
      countryCode: input.countryCode,
      action: input.action,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return row;
  }

  async listGeoRules() {
    const rows = await this.drizzle.db.select().from(countryRule);
    return rows.map(toGeoRuleView);
  }
}

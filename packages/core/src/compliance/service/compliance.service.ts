import {
  DrizzleService,
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  makeOwnershipError,
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

    const countryCode = ipAddress ? (await this.geoIp.lookup(ipAddress)).countryCode : null;

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
        confirm: input.confirm,
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
}

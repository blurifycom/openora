import {
  DrizzleService,
  findOneOrThrow,
  makeNotFoundError,
  makeOwnershipError,
  serializeRow,
} from '@openora/core/server';
import { eq } from 'drizzle-orm';
import { countryRule, globalKycConfig } from '../schema/index.js';
import type { UpsertCountryRuleInput, SetGlobalKycConfigInput } from '../contract/index.js';
import type { AuditWritePort, ClientMeta, GeoIpAdapter, User } from '@openora/core/contracts';

export const LimitNotFoundError = makeNotFoundError('Limit');

export const LimitOwnershipError = makeOwnershipError('Limit');

export const CountryRuleNotFoundError = makeNotFoundError('CountryRule');

export const GlobalKycConfigNotFoundError = makeNotFoundError('GlobalKycConfig');

// Mirrors the column defaults in schema/index.ts - used as "previous value" for a
// field on a brand-new row, where there is no `before` row to read it from.
const COUNTRY_RULE_FIELD_DEFAULTS = {
  blacklisted: false,
  redirectIp: false,
  kycRequired: true,
} as const;
const COUNTRY_RULE_BOOLEAN_FIELDS = Object.keys(
  COUNTRY_RULE_FIELD_DEFAULTS,
) as (keyof typeof COUNTRY_RULE_FIELD_DEFAULTS)[];
const GLOBAL_KYC_ENABLED_DEFAULT = true;

export class ComplianceService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly geoIp: GeoIpAdapter | null,
    private readonly audit: AuditWritePort,
  ) {}

  async geoCheck(ipAddress: string | null) {
    const countryCode =
      this.geoIp && ipAddress ? (await this.geoIp.lookup(ipAddress)).countryCode : null;

    if (!countryCode) {
      // With rules configured, an unresolvable address is a gap in the gate, not a pass.
      const [anyRule] = await this.drizzle.db
        .select({ id: countryRule.id })
        .from(countryRule)
        .limit(1);
      return anyRule
        ? { allowed: false, countryCode: null, reason: 'Geolocation could not be determined' }
        : { allowed: true, countryCode: null, reason: null };
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
      const [before] = await tx
        .select()
        .from(countryRule)
        .where(eq(countryRule.countryCode, input.countryCode));

      const row = findOneOrThrow(
        await tx
          .insert(countryRule)
          .values({
            countryCode: input.countryCode,
            blacklisted: input.blacklisted,
            redirectIp: input.redirectIp,
            kycRequired: input.kycRequired,
            updatedAt: new Date(),
            updatedBy: actorId,
          })
          .onConflictDoUpdate({
            target: countryRule.countryCode,
            set: {
              blacklisted: input.blacklisted,
              redirectIp: input.redirectIp,
              kycRequired: input.kycRequired,
              updatedAt: new Date(),
              updatedBy: actorId,
            },
          })
          .returning(),
        new CountryRuleNotFoundError(input.countryCode),
      );

      for (const field of COUNTRY_RULE_BOOLEAN_FIELDS) {
        const previousValue = before ? before[field] : COUNTRY_RULE_FIELD_DEFAULTS[field];
        const newValue = row[field];
        if (previousValue === newValue) {
          continue;
        }
        await this.audit.recordInTransaction(tx, {
          actorId,
          actorType: 'admin',
          action: 'compliance.country_rule.setting_changed',
          resourceType: 'country-rule',
          resourceId: input.countryCode,
          before: { setting: field, value: previousValue },
          after: { setting: field, value: newValue },
          ...meta,
        });
      }

      // Assigned to a local first, not returned inline: TS's inference for serializeRow's
      // date-field generic widens to `keyof Row` when the call sits directly in a `return`
      // inside a generic callback (db.transaction<T>) whose result also has to satisfy an
      // outer contextual type (the router handler's oRPC output schema) - breaking the
      // expression in two keeps the two inference sites independent.
      const serialized = serializeRow(row, { dateFields: ['createdAt', 'updatedAt'] });
      return serialized;
    });
  }

  async listCountryRules() {
    const rows = await this.drizzle.db.select().from(countryRule);
    return rows.map((r) => serializeRow(r, { dateFields: ['createdAt', 'updatedAt'] }));
  }

  async getGlobalKycConfig() {
    const [row] = await this.drizzle.db
      .select()
      .from(globalKycConfig)
      .where(eq(globalKycConfig.singletonKey, 'global'));
    return row
      ? serializeRow(row, { dateFields: ['createdAt', 'updatedAt'] })
      : { enabled: GLOBAL_KYC_ENABLED_DEFAULT, updatedAt: null, updatedBy: null };
  }

  async setGlobalKycConfig(input: SetGlobalKycConfigInput, actorId: User['id'], meta?: ClientMeta) {
    return this.drizzle.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(globalKycConfig)
        .where(eq(globalKycConfig.singletonKey, 'global'));

      const row = findOneOrThrow(
        await tx
          .insert(globalKycConfig)
          .values({
            singletonKey: 'global',
            enabled: input.enabled,
            updatedAt: new Date(),
            updatedBy: actorId,
          })
          .onConflictDoUpdate({
            target: globalKycConfig.singletonKey,
            set: { enabled: input.enabled, updatedAt: new Date(), updatedBy: actorId },
          })
          .returning(),
        new GlobalKycConfigNotFoundError('global'),
      );

      const previousValue = before ? before.enabled : GLOBAL_KYC_ENABLED_DEFAULT;
      if (previousValue !== row.enabled) {
        await this.audit.recordInTransaction(tx, {
          actorId,
          actorType: 'admin',
          action: 'compliance.global_kyc.set',
          resourceType: 'global-kyc-config',
          resourceId: 'global',
          before: { enabled: previousValue },
          after: { enabled: row.enabled },
          ...meta,
        });
      }

      // See the comment in upsertCountryRule above - same inference-widening reason.
      const serialized = serializeRow(row, { dateFields: ['createdAt', 'updatedAt'] });
      return serialized;
    });
  }
}

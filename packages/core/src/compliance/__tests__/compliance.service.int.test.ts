import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  defineIgamingConfig,
  type GeoIpAdapter,
  type IgamingConfig,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { mock, makeAuditWriter, makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, countryRule, globalKycConfig } from '../schema/index.js';
import {
  ComplianceService,
  CountryRuleConfirmationRequiredError,
  CountryRuleVersionConflictError,
  LicensedJurisdictionBlacklistError,
} from '../service/compliance.service.js';

let db: TestDb;

function makeService(countryCode?: string | null, igaming: IgamingConfig | null = null) {
  const audit = makeAuditWriter();
  const events = makeEventBus();
  const geoIp =
    countryCode === undefined
      ? null
      : mock<GeoIpAdapter>({ lookup: vi.fn(async () => ({ countryCode })) });
  const svc = new ComplianceService(db.drizzle, events, geoIp, audit, igaming);
  return { svc, audit, events };
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${userLimit}, ${countryRule}, ${globalKycConfig} RESTART IDENTITY CASCADE`,
  );
});

describe('ComplianceService.geoCheck (real PG)', () => {
  it('allows the request when no geo-ip port is bound', async () => {
    const { svc } = makeService();

    expect(await svc.geoCheck('1.2.3.4')).toEqual({
      allowed: true,
      countryCode: null,
      reason: null,
    });
  });

  it('allows the request when the lookup resolves no country', async () => {
    const { svc } = makeService(null);

    expect(await svc.geoCheck('1.2.3.4')).toMatchObject({ allowed: true, countryCode: null });
  });

  it('allows an unresolvable address when country rules exist but none blacklists', async () => {
    const { svc } = makeService(null);
    await db.drizzle.db.insert(countryRule).values({ countryCode: 'DE', kycRequired: false });

    expect(await svc.geoCheck('1.2.3.4')).toMatchObject({ allowed: true, countryCode: null });
  });

  it('allows a resolved country that carries no rule', async () => {
    const { svc } = makeService('DE');

    expect(await svc.geoCheck('1.2.3.4')).toMatchObject({ allowed: true, countryCode: 'DE' });
  });

  it('blocks a country whose rule blacklists it, with a reason', async () => {
    const { svc } = makeService('US');
    await db.drizzle.db.insert(countryRule).values({ countryCode: 'US', blacklisted: true });

    const result = await svc.geoCheck('1.2.3.4');

    expect(result).toMatchObject({ allowed: false, countryCode: 'US' });
    expect(result.reason).toContain('US');
  });

  it('allows a country whose rule exists but does not blacklist it', async () => {
    const { svc } = makeService('DE');
    await db.drizzle.db.insert(countryRule).values({ countryCode: 'DE', blacklisted: false });

    expect(await svc.geoCheck('1.2.3.4')).toMatchObject({ allowed: true, countryCode: 'DE' });
  });

  it('enforces blocked countries from the runtime igaming configuration', async () => {
    const igaming = defineIgamingConfig({
      branding: { name: 'Test' },
      currencies: ['EUR'],
      jurisdictions: ['MT'],
      blockedCountries: ['US'],
    });
    const { svc } = makeService('US', igaming);

    expect(await svc.geoCheck('1.2.3.4')).toMatchObject({ allowed: false, countryCode: 'US' });
  });
});

describe('ComplianceService.upsertCountryRule (real PG)', () => {
  it('creates a rule and audits every field that differs from the row defaults', async () => {
    const { svc, audit } = makeService();
    const actorId = randomUUID();

    const rule = await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: true,
        redirectIp: false,
        kycRequired: true,
        expectedUpdatedAt: null,
      },
      actorId,
    );

    expect(rule).toMatchObject({
      countryCode: 'FR',
      blacklisted: true,
      redirectIp: false,
      kycRequired: true,
    });
    // Only `blacklisted` differs from the column defaults (false, false, true) - one audit row.
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId,
        action: 'compliance.country_rule.setting_changed',
        resourceType: 'country-rule',
        resourceId: 'FR',
        before: { setting: 'blacklisted', value: false },
        after: { setting: 'blacklisted', value: true },
      }),
    );
  });

  it('upserts by country code, auditing only the fields that actually changed', async () => {
    const { svc, audit } = makeService();
    const created = await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: true,
        redirectIp: false,
        kycRequired: true,
        expectedUpdatedAt: null,
      },
      randomUUID(),
    );
    audit.recordInTransaction.mockClear();

    const updated = await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: true,
        redirectIp: true,
        kycRequired: false,
        expectedUpdatedAt: created.updatedAt,
        confirm: true,
      },
      randomUUID(),
    );

    expect(updated).toMatchObject({ blacklisted: true, redirectIp: true, kycRequired: false });
    expect(await db.drizzle.db.select().from(countryRule)).toHaveLength(1);
    // blacklisted stayed true (unchanged) - only redirectIp and kycRequired changed.
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(2);
  });

  it('writes zero audit rows when a save changes nothing', async () => {
    const { svc, audit } = makeService();
    await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: false,
        redirectIp: false,
        kycRequired: true,
        expectedUpdatedAt: null,
      },
      randomUUID(),
    );
    audit.recordInTransaction.mockClear();

    await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: false,
        redirectIp: false,
        kycRequired: true,
        expectedUpdatedAt: null,
      },
      randomUUID(),
    );

    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('lists every country that has a rule', async () => {
    const { svc } = makeService();
    await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: true,
        redirectIp: false,
        kycRequired: true,
        expectedUpdatedAt: null,
      },
      randomUUID(),
    );
    await svc.upsertCountryRule(
      {
        countryCode: 'DE',
        blacklisted: false,
        redirectIp: true,
        kycRequired: true,
        expectedUpdatedAt: null,
      },
      randomUUID(),
    );

    const rules = await svc.listCountryRules();

    expect(rules.map((r) => r.countryCode).sort()).toEqual(['DE', 'FR']);
  });

  it('requires confirmation for every weakening transition', async () => {
    const { svc } = makeService();
    const rule = await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: true,
        redirectIp: true,
        kycRequired: true,
        expectedUpdatedAt: null,
      },
      randomUUID(),
    );

    await expect(
      svc.upsertCountryRule(
        {
          countryCode: 'FR',
          blacklisted: false,
          redirectIp: true,
          kycRequired: true,
          expectedUpdatedAt: rule.updatedAt,
        },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(CountryRuleConfirmationRequiredError);
  });

  it('rejects a full-object write based on a stale version', async () => {
    const { svc } = makeService();
    const created = await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: false,
        redirectIp: false,
        kycRequired: true,
        expectedUpdatedAt: null,
      },
      randomUUID(),
    );
    const updated = await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: true,
        redirectIp: false,
        kycRequired: true,
        expectedUpdatedAt: created.updatedAt,
      },
      randomUUID(),
    );

    await expect(
      svc.upsertCountryRule(
        {
          countryCode: 'FR',
          blacklisted: false,
          redirectIp: true,
          kycRequired: true,
          expectedUpdatedAt: created.updatedAt,
        },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(CountryRuleVersionConflictError);
    expect((await svc.listCountryRules()).at(0)).toMatchObject(updated);
  });

  it('refuses to blacklist a configured licensed jurisdiction', async () => {
    const igaming = defineIgamingConfig({
      branding: { name: 'Test' },
      currencies: ['EUR'],
      jurisdictions: ['MT'],
    });
    const { svc } = makeService(undefined, igaming);

    await expect(
      svc.upsertCountryRule(
        {
          countryCode: 'MT',
          blacklisted: true,
          redirectIp: false,
          kycRequired: true,
          expectedUpdatedAt: null,
        },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(LicensedJurisdictionBlacklistError);
  });
});

describe('ComplianceService legacy geo rules (real PG)', () => {
  it('maps the legacy geo-rule API onto country rules and emits its legacy event', async () => {
    const { svc, events } = makeService();
    const actorId = randomUUID();

    const rule = await svc.addGeoRule({ countryCode: 'FR', action: 'block' }, actorId);

    expect(rule).toMatchObject({ countryCode: 'FR', action: 'block' });
    expect((await svc.listCountryRules()).at(0)).toMatchObject({
      countryCode: 'FR',
      blacklisted: true,
    });
    expect(events.emit).toHaveBeenCalledWith(
      'compliance.geo-rule.added',
      expect.objectContaining({ countryCode: 'FR', action: 'block', actorId }),
    );
  });
});

describe('ComplianceService global KYC config (real PG)', () => {
  it('defaults to enabled when no row exists yet', async () => {
    const { svc } = makeService();

    expect(await svc.getGlobalKycConfig()).toMatchObject({ enabled: true, updatedAt: null });
  });

  it('writes one audit row when the toggle actually changes', async () => {
    const { svc, audit } = makeService();
    const actorId = randomUUID();

    const config = await svc.setGlobalKycConfig(
      { enabled: false, confirm: true, expectedUpdatedAt: null },
      actorId,
    );

    expect(config.enabled).toBe(false);
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId,
        action: 'compliance.global_kyc.set',
        resourceType: 'global-kyc-config',
        resourceId: 'global',
        before: { enabled: true },
        after: { enabled: false },
      }),
    );
  });

  it('writes zero audit rows when re-set to the same value', async () => {
    const { svc, audit } = makeService();
    const config = await svc.setGlobalKycConfig(
      { enabled: false, confirm: true, expectedUpdatedAt: null },
      randomUUID(),
    );
    audit.recordInTransaction.mockClear();

    await svc.setGlobalKycConfig(
      { enabled: false, confirm: true, expectedUpdatedAt: config.updatedAt },
      randomUUID(),
    );

    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });
});

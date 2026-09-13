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
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { game, gameProvider } from '@openora/core/casino/schema/gaming';
import { mock, makeAuditWriter, makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, countryRule, globalKycConfig, gameGeoRule } from '../schema/index.js';
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

async function seedGame(id: string, name: string) {
  const [provider] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `studio-${randomUUID()}`, name: 'Studio', isActive: true })
    .returning();
  await db.drizzle.db.insert(game).values({
    id,
    name,
    slug: `game-${randomUUID()}`,
    providerId: provider.id,
    aggregator: 'mock',
    isActive: true,
  });
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateGaming]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${userLimit}, ${countryRule}, ${globalKycConfig}, ${gameGeoRule}, ${game}, ${gameProvider} RESTART IDENTITY CASCADE`,
  );
});

describe('ComplianceService.geoCheck (real PG)', () => {
  it('allows the request when no geo-ip port is bound, even with a blacklist', async () => {
    const { svc } = makeService();
    await db.drizzle.db.insert(countryRule).values({ countryCode: 'US', action: 'block' });

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

  it('fails closed when the lookup resolves no country and a global rule exists', async () => {
    const { svc } = makeService(null);
    await db.drizzle.db.insert(countryRule).values({ countryCode: 'US', action: 'block' });

    expect(await svc.geoCheck('1.2.3.4')).toEqual({
      allowed: false,
      countryCode: null,
      reason: 'Geolocation could not be determined',
    });
  });

  it('allows an unresolvable address when country rules exist but none blacklists', async () => {
    const { svc } = makeService(null);
    await db.drizzle.db
      .insert(countryRule)
      .values({ countryCode: 'DE', action: 'allow', kycRequired: false });

    expect(await svc.geoCheck('1.2.3.4')).toMatchObject({ allowed: true, countryCode: null });
  });

  it('allows a resolved country that carries no rule', async () => {
    const { svc } = makeService('DE');

    expect(await svc.geoCheck('1.2.3.4')).toMatchObject({ allowed: true, countryCode: 'DE' });
  });

  it('blocks a country whose rule blacklists it, with a reason', async () => {
    const { svc } = makeService('US');
    await db.drizzle.db.insert(countryRule).values({ countryCode: 'US', action: 'block' });

    const result = await svc.geoCheck('1.2.3.4');

    expect(result).toMatchObject({ allowed: false, countryCode: 'US' });
    expect(result.reason).toContain('US');
  });

  it('allows a country whose rule exists but does not blacklist it', async () => {
    const { svc } = makeService('DE');
    await db.drizzle.db.insert(countryRule).values({ countryCode: 'DE', action: 'allow' });

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
        confirm: true,
      },
      actorId,
    );

    expect(rule).toMatchObject({
      countryCode: 'FR',
      blacklisted: true,
      redirectIp: false,
      kycRequired: true,
    });
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
        confirm: true,
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
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(2);
  });

  it('writes zero audit rows when a save changes nothing', async () => {
    const { svc, audit } = makeService();
    const created = await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: false,
        redirectIp: false,
        kycRequired: true,
        expectedUpdatedAt: null,
        confirm: true,
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
        expectedUpdatedAt: created.updatedAt,
        confirm: true,
      },
      randomUUID(),
    );

    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('audits creation when a new rule uses every default value', async () => {
    const { svc, audit } = makeService();
    const actorId = randomUUID();

    const rule = await svc.upsertCountryRule(
      {
        countryCode: 'FR',
        blacklisted: false,
        redirectIp: false,
        kycRequired: true,
        expectedUpdatedAt: null,
        confirm: true,
      },
      actorId,
    );

    expect(rule).toMatchObject({ updatedBy: actorId });
    expect(rule.updatedAt).not.toBeNull();
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId,
        action: 'compliance.country_rule.created',
        resourceType: 'country-rule',
        resourceId: 'FR',
        before: null,
        after: { blacklisted: false, redirectIp: false, kycRequired: true },
      }),
    );
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
        confirm: true,
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
        confirm: true,
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

  it('requires confirmation before blacklisting a country', async () => {
    const { svc } = makeService();

    await expect(
      svc.upsertCountryRule(
        {
          countryCode: 'FR',
          blacklisted: true,
          redirectIp: false,
          kycRequired: true,
          expectedUpdatedAt: null,
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
        confirm: true,
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
          confirm: true,
        },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(LicensedJurisdictionBlacklistError);
  });
});

describe('ComplianceService legacy geo rules (real PG)', () => {
  it('maps the legacy geo-rule API onto country rules without requiring confirm', async () => {
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

describe('ComplianceService per-game geo rules (real PG)', () => {
  it('lets a global block win before the game-specific decision', async () => {
    const { svc } = makeService('US');
    await db.drizzle.db.insert(countryRule).values({ countryCode: 'US', action: 'block' });

    await expect(
      svc.checkGame({
        gameId: '00000000-0000-0000-0000-000000000111',
        ipAddress: '1.2.3.4',
      }),
    ).resolves.toEqual({ allowed: false, countryCode: 'US', reason: 'global_block' });
  });

  it('blocks only the matching game and country', async () => {
    const blockedGameId = '00000000-0000-0000-0000-000000000112';
    const otherGameId = '00000000-0000-0000-0000-000000000113';
    const { svc } = makeService('US');
    await db.drizzle.db.insert(gameGeoRule).values({
      gameId: blockedGameId,
      countryCode: 'US',
      reason: 'licence restriction',
    });

    await expect(svc.checkGame({ gameId: blockedGameId, ipAddress: '1.2.3.4' })).resolves.toEqual({
      allowed: false,
      countryCode: 'US',
      reason: 'game_block',
    });
    await expect(svc.checkGame({ gameId: otherGameId, ipAddress: '1.2.3.4' })).resolves.toEqual({
      allowed: true,
      countryCode: 'US',
      reason: null,
    });
  });

  it('fails closed on unresolved geo when the game has a geo rule', async () => {
    const gameId = '00000000-0000-0000-0000-000000000114';
    const { svc } = makeService(null);
    await db.drizzle.db
      .insert(gameGeoRule)
      .values({ gameId, countryCode: 'US', reason: 'licence restriction' });

    await expect(svc.checkGame({ gameId, ipAddress: '1.2.3.4' })).resolves.toEqual({
      allowed: false,
      countryCode: null,
      reason: 'geo_unresolved',
    });
  });

  it('fails closed on unresolved geo when a global rule exists', async () => {
    const gameId = '00000000-0000-0000-0000-000000000119';
    const { svc } = makeService(null);
    await db.drizzle.db.insert(countryRule).values({ countryCode: 'US', action: 'block' });

    await expect(svc.checkGame({ gameId, ipAddress: '1.2.3.4' })).resolves.toEqual({
      allowed: false,
      countryCode: null,
      reason: 'geo_unresolved',
    });
  });

  it('normalizes country codes returned by the geo-ip adapter', async () => {
    const gameId = '00000000-0000-0000-0000-000000000116';
    const { svc } = makeService('us');
    await db.drizzle.db.insert(gameGeoRule).values({
      gameId,
      countryCode: 'US',
      reason: 'licence restriction',
    });

    await expect(svc.checkGame({ gameId, ipAddress: '1.2.3.4' })).resolves.toEqual({
      allowed: false,
      countryCode: 'US',
      reason: 'game_block',
    });
  });

  it('fails closed when the geo-ip adapter returns an invalid country code', async () => {
    const gameId = '00000000-0000-0000-0000-000000000117';
    const { svc } = makeService('USA');
    await db.drizzle.db.insert(gameGeoRule).values({
      gameId,
      countryCode: 'US',
      reason: 'licence restriction',
    });

    await expect(svc.checkGame({ gameId, ipAddress: '1.2.3.4' })).resolves.toEqual({
      allowed: false,
      countryCode: null,
      reason: 'geo_unresolved',
    });
  });

  it('upserts and deletes an existing-game rule with auditable before and after state', async () => {
    const gameId = '00000000-0000-0000-0000-000000000115';
    const actorId = randomUUID();
    const { svc, events } = makeService();
    await seedGame(gameId, 'Game');

    const created = await svc.upsertGameGeoRule(
      { gameId, countryCode: 'US', reason: 'licence restriction' },
      actorId,
      { ip: '1.2.3.4', userAgent: 'agent' },
    );
    await svc.upsertGameGeoRule(
      { gameId, countryCode: 'US', reason: 'updated restriction' },
      actorId,
      { ip: '1.2.3.4', userAgent: 'agent' },
    );
    await svc.deleteGameGeoRule({ id: created.id, reason: 'licence restored' }, actorId, {
      ip: '1.2.3.4',
      userAgent: 'agent',
    });

    expect(events.emit).toHaveBeenCalledWith(
      'compliance.game-geo-rule.upserted',
      expect.objectContaining({
        gameId,
        actorId,
        before: expect.objectContaining({ reason: 'licence restriction' }),
        after: expect.objectContaining({ reason: 'updated restriction' }),
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'compliance.game-geo-rule.deleted',
      expect.objectContaining({ gameId, actorId, reason: 'licence restored', after: null }),
    );
    expect(await svc.listGameGeoRules({ gameId })).toEqual([]);
  });

  it('serializes concurrent upserts before emitting audit snapshots', async () => {
    const gameId = '00000000-0000-0000-0000-000000000118';
    const actorId = randomUUID();
    const { svc, events } = makeService();
    await seedGame(gameId, 'Concurrent Game');

    await Promise.all([
      svc.upsertGameGeoRule({ gameId, countryCode: 'US', reason: 'first restriction' }, actorId, {
        ip: null,
        userAgent: null,
      }),
      svc.upsertGameGeoRule({ gameId, countryCode: 'US', reason: 'second restriction' }, actorId, {
        ip: null,
        userAgent: null,
      }),
    ]);

    const upsertPayloads = events.emit.mock.calls
      .filter(([event]) => event === 'compliance.game-geo-rule.upserted')
      .map(([, payload]) => payload);
    expect(upsertPayloads).toHaveLength(2);
    expect(upsertPayloads.filter(({ before }) => before === null)).toHaveLength(1);

    const initial = upsertPayloads.find(({ before }) => before === null);
    const followup = upsertPayloads.find(({ before }) => before !== null);
    expect(followup?.before?.reason).toBe(initial?.after.reason);
  });
});

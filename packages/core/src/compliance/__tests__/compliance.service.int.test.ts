import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { count, eq, inArray, sql } from 'drizzle-orm';
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
import {
  userLimit,
  countryRule,
  globalKycConfig,
  gameGeoRule,
  providerGeoRule,
} from '../schema/index.js';
import {
  ComplianceService,
  CountryRuleConfirmationRequiredError,
  CountryRuleVersionConflictError,
  GeoRuleBulkTooManyGamesError,
  GeoRuleProviderNotFoundError,
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

async function seedProvider() {
  const [provider] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `studio-${randomUUID()}`, name: 'Studio', isActive: true })
    .returning();
  return provider.id;
}

async function seedGame(id: string, name: string, providerId?: string) {
  await db.drizzle.db.insert(game).values({
    id,
    name,
    slug: `game-${randomUUID()}`,
    providerId: providerId ?? (await seedProvider()),
    aggregator: 'mock',
    isActive: true,
  });
}

async function seedManyGames(providerId: string, gameCount: number) {
  const rows = await db.drizzle.db
    .insert(game)
    .values(
      Array.from({ length: gameCount }, () => ({
        name: 'Game',
        slug: `game-${randomUUID()}`,
        providerId,
        aggregator: 'mock',
        isActive: true,
      })),
    )
    .returning({ id: game.id });
  return rows.map((row) => row.id);
}

const NO_META = { ip: null, userAgent: null };

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateGaming]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${userLimit}, ${countryRule}, ${globalKycConfig}, ${gameGeoRule}, ${providerGeoRule}, ${game}, ${gameProvider} RESTART IDENTITY CASCADE`,
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

describe('ComplianceService.resolveKycRequirement (real PG)', () => {
  it('is not required when KYC is globally disabled, even for a country requiring it', async () => {
    const { svc } = makeService();
    await svc.setGlobalKycConfig(
      { enabled: false, confirm: true, expectedUpdatedAt: null },
      randomUUID(),
    );

    expect(await svc.resolveKycRequirement('FR')).toEqual({
      required: false,
      reason: 'global_disabled',
    });
  });

  it('is not required for a country whose rule marks it exempt', async () => {
    const { svc } = makeService();
    await db.drizzle.db
      .insert(countryRule)
      .values({ countryCode: 'DE', action: 'allow', kycRequired: false });

    expect(await svc.resolveKycRequirement('DE')).toEqual({
      required: false,
      reason: 'country_exempt',
    });
  });

  it('is required for a country with no rule row (schema default)', async () => {
    const { svc } = makeService();

    expect(await svc.resolveKycRequirement('FR')).toEqual({ required: true, reason: 'required' });
  });

  it('fails closed - required - when the country could not be resolved', async () => {
    const { svc } = makeService();

    expect(await svc.resolveKycRequirement(null)).toEqual({
      required: true,
      reason: 'country_unknown',
    });
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
    await seedGame(blockedGameId, 'Blocked');
    await seedGame(otherGameId, 'Other');
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
    await seedGame(gameId, 'Unresolved');
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
    await seedGame(gameId, 'Lowercase');
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
    await seedGame(gameId, 'Invalid country');
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

    await svc.upsertGameGeoRules(
      { gameId, countryCodes: ['US'], reason: 'licence restriction' },
      actorId,
      { ip: '1.2.3.4', userAgent: 'agent' },
    );
    await svc.upsertGameGeoRules(
      { gameId, countryCodes: ['US'], reason: 'updated restriction' },
      actorId,
      { ip: '1.2.3.4', userAgent: 'agent' },
    );
    await svc.deleteGameGeoRules(
      { gameId, countryCodes: ['US'], reason: 'licence restored' },
      actorId,
      { ip: '1.2.3.4', userAgent: 'agent' },
    );

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
    expect(await svc.listGameGeoRules({ gameIds: [gameId], page: 1, limit: 100 })).toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 100,
    });
  });

  it('lists rules for the requested games one page at a time', async () => {
    const [first, second, other] = [randomUUID(), randomUUID(), randomUUID()];
    const actorId = randomUUID();
    const meta = { ip: null, userAgent: null };
    const { svc } = makeService();
    for (const [gameId, name] of [
      [first, 'First'],
      [second, 'Second'],
      [other, 'Other'],
    ] as const) {
      await seedGame(gameId, name);
      await svc.upsertGameGeoRules(
        { gameId, countryCodes: ['US'], reason: 'licence' },
        actorId,
        meta,
      );
    }
    await svc.upsertGameGeoRules(
      { gameId: first, countryCodes: ['DE'], reason: 'licence' },
      actorId,
      meta,
    );

    const pageOne = await svc.listGameGeoRules({ gameIds: [first, second], page: 1, limit: 2 });
    const pageTwo = await svc.listGameGeoRules({ gameIds: [first, second], page: 2, limit: 2 });

    expect(pageOne).toMatchObject({ total: 3, page: 1, limit: 2 });
    expect(pageOne.items).toHaveLength(2);
    expect(pageTwo).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(pageTwo.items).toHaveLength(1);
    expect(
      [...pageOne.items, ...pageTwo.items].map((r) => [r.gameId, r.countryCode]).sort(),
    ).toEqual(
      [
        [first, 'DE'],
        [first, 'US'],
        [second, 'US'],
      ].sort(),
    );
    expect((await svc.listGameGeoRules({ page: 1, limit: 100 })).total).toBe(4);
  });

  it('serializes concurrent upserts before emitting audit snapshots', async () => {
    const gameId = '00000000-0000-0000-0000-000000000118';
    const actorId = randomUUID();
    const { svc, events } = makeService();
    await seedGame(gameId, 'Concurrent Game');

    await Promise.all([
      svc.upsertGameGeoRules(
        { gameId, countryCodes: ['US'], reason: 'first restriction' },
        actorId,
        {
          ip: null,
          userAgent: null,
        },
      ),
      svc.upsertGameGeoRules(
        { gameId, countryCodes: ['US'], reason: 'second restriction' },
        actorId,
        {
          ip: null,
          userAgent: null,
        },
      ),
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

describe('ComplianceService per-provider geo rules (real PG)', () => {
  it('blocks every game of the provider in the matching country only', async () => {
    const blockedProviderId = await seedProvider();
    const otherProviderId = await seedProvider();
    const firstGameId = '00000000-0000-0000-0000-000000000211';
    const secondGameId = '00000000-0000-0000-0000-000000000212';
    const otherGameId = '00000000-0000-0000-0000-000000000213';
    await seedGame(firstGameId, 'First', blockedProviderId);
    await seedGame(secondGameId, 'Second', blockedProviderId);
    await seedGame(otherGameId, 'Other', otherProviderId);
    await db.drizzle.db.insert(providerGeoRule).values({
      providerId: blockedProviderId,
      countryCode: 'US',
      reason: 'provider licence restriction',
    });

    const { svc } = makeService('US');
    for (const gameId of [firstGameId, secondGameId]) {
      await expect(svc.checkGame({ gameId, ipAddress: '1.2.3.4' })).resolves.toEqual({
        allowed: false,
        countryCode: 'US',
        reason: 'provider_block',
      });
    }
    await expect(svc.checkGame({ gameId: otherGameId, ipAddress: '1.2.3.4' })).resolves.toEqual({
      allowed: true,
      countryCode: 'US',
      reason: null,
    });
    await expect(
      makeService('DE').svc.checkGame({ gameId: firstGameId, ipAddress: '1.2.3.4' }),
    ).resolves.toEqual({ allowed: true, countryCode: 'DE', reason: null });
  });

  it('reports the provider block when the game is blocked too', async () => {
    const providerId = await seedProvider();
    const gameId = '00000000-0000-0000-0000-000000000214';
    await seedGame(gameId, 'Doubly blocked', providerId);
    await db.drizzle.db
      .insert(providerGeoRule)
      .values({ providerId, countryCode: 'US', reason: 'provider licence restriction' });
    await db.drizzle.db
      .insert(gameGeoRule)
      .values({ gameId, countryCode: 'US', reason: 'game licence restriction' });

    await expect(
      makeService('US').svc.checkGame({ gameId, ipAddress: '1.2.3.4' }),
    ).resolves.toEqual({ allowed: false, countryCode: 'US', reason: 'provider_block' });
  });

  it('fails closed on unresolved geo when the game provider has a geo rule', async () => {
    const providerId = await seedProvider();
    const gameId = '00000000-0000-0000-0000-000000000215';
    await seedGame(gameId, 'Unresolved', providerId);
    await db.drizzle.db
      .insert(providerGeoRule)
      .values({ providerId, countryCode: 'US', reason: 'provider licence restriction' });

    await expect(
      makeService(null).svc.checkGame({ gameId, ipAddress: '1.2.3.4' }),
    ).resolves.toEqual({ allowed: false, countryCode: null, reason: 'geo_unresolved' });
  });

  it('denies an unknown game instead of skipping the provider check', async () => {
    const { svc } = makeService('US');

    await expect(svc.checkGame({ gameId: randomUUID(), ipAddress: '1.2.3.4' })).resolves.toEqual({
      allowed: false,
      countryCode: null,
      reason: 'game_not_found',
    });
  });

  it('rejects a rule for an unknown provider', async () => {
    const { svc, events } = makeService();

    await expect(
      svc.upsertProviderGeoRules(
        { providerId: randomUUID(), countryCodes: ['US'], reason: 'licence restriction' },
        randomUUID(),
        { ip: null, userAgent: null },
      ),
    ).rejects.toBeInstanceOf(GeoRuleProviderNotFoundError);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('upserts and deletes a provider rule with auditable before and after state', async () => {
    const providerId = await seedProvider();
    const actorId = randomUUID();
    const meta = { ip: '1.2.3.4', userAgent: 'agent' };
    const { svc, events } = makeService();

    const [created] = await svc.upsertProviderGeoRules(
      { providerId, countryCodes: ['US'], reason: 'licence restriction' },
      actorId,
      meta,
    );
    await svc.upsertProviderGeoRules(
      { providerId, countryCodes: ['US'], reason: 'updated restriction' },
      actorId,
      meta,
    );
    expect(
      (await svc.listProviderGeoRules({ providerIds: [providerId], page: 1, limit: 100 })).items,
    ).toEqual([
      expect.objectContaining({ id: created?.id, providerId, reason: 'updated restriction' }),
    ]);

    await svc.deleteProviderGeoRules(
      { providerId, countryCodes: ['US'], reason: 'licence restored' },
      actorId,
      meta,
    );

    expect(events.emit).toHaveBeenCalledWith(
      'compliance.provider-geo-rule.upserted',
      expect.objectContaining({
        providerId,
        actorId,
        before: expect.objectContaining({ reason: 'licence restriction' }),
        after: expect.objectContaining({ reason: 'updated restriction' }),
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'compliance.provider-geo-rule.deleted',
      expect.objectContaining({ providerId, actorId, reason: 'licence restored', after: null }),
    );
    expect(
      await svc.listProviderGeoRules({ providerIds: [providerId], page: 1, limit: 100 }),
    ).toEqual({ items: [], total: 0, page: 1, limit: 100 });
  });

  it('lists rules for the requested providers one page at a time', async () => {
    const [first, second, other] = [
      await seedProvider(),
      await seedProvider(),
      await seedProvider(),
    ];
    const actorId = randomUUID();
    const meta = { ip: null, userAgent: null };
    const { svc } = makeService();
    for (const providerId of [first, second, other]) {
      await svc.upsertProviderGeoRules(
        { providerId, countryCodes: ['US'], reason: 'licence' },
        actorId,
        meta,
      );
    }
    await svc.upsertProviderGeoRules(
      { providerId: first, countryCodes: ['DE'], reason: 'licence' },
      actorId,
      meta,
    );

    const input = { providerIds: [first, second], limit: 2 };
    const pageOne = await svc.listProviderGeoRules({ ...input, page: 1 });
    const pageTwo = await svc.listProviderGeoRules({ ...input, page: 2 });

    expect(pageOne).toMatchObject({ total: 3, page: 1, limit: 2 });
    expect(pageOne.items).toHaveLength(2);
    expect(pageTwo).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(pageTwo.items).toHaveLength(1);
    expect(
      [...pageOne.items, ...pageTwo.items].map((r) => [r.providerId, r.countryCode]).sort(),
    ).toEqual(
      [
        [first, 'DE'],
        [first, 'US'],
        [second, 'US'],
      ].sort(),
    );
    expect((await svc.listProviderGeoRules({ page: 1, limit: 100 })).total).toBe(4);
  });
});

describe('ComplianceService.listGloballyBlockedCountries (real PG)', () => {
  it('unions the runtime config with block rules, sorted and deduped, ignoring allow rules', async () => {
    const igaming = defineIgamingConfig({
      branding: { name: 'Test' },
      currencies: ['EUR'],
      jurisdictions: ['MT'],
      blockedCountries: ['US', 'DE'],
    });
    const { svc } = makeService(undefined, igaming);
    await db.drizzle.db.insert(countryRule).values([
      { countryCode: 'DE', action: 'block' },
      { countryCode: 'FR', action: 'block' },
      { countryCode: 'GB', action: 'allow' },
    ]);

    expect(await svc.listGloballyBlockedCountries()).toEqual(['DE', 'FR', 'US']);
  });

  it('is empty when nothing blocks globally', async () => {
    const { svc } = makeService();

    expect(await svc.listGloballyBlockedCountries()).toEqual([]);
  });
});

describe('ComplianceService bulk game geo rules (real PG)', () => {
  it('restricts many games at once, leaving an already-restricted game (and its reason) untouched', async () => {
    const providerId = await seedProvider();
    const [first, second, third] = await seedManyGames(providerId, 3);
    const actorId = randomUUID();
    const { svc, events, audit } = makeService();
    await svc.upsertGameGeoRules(
      { gameId: first!, countryCodes: ['DK'], reason: 'original reason' },
      actorId,
      NO_META,
    );
    events.emit.mockClear();

    const result = await svc.bulkRestrictGameGeoRules(
      { gameIds: [first!, second!, third!], countryCode: 'DK', reason: 'bulk restriction' },
      actorId,
      NO_META,
    );

    expect(result).toEqual({
      changed: 2,
      unchanged: 1,
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(audit.recordEventsInTransaction).toHaveBeenCalledTimes(1);
    const [, auditTopic, auditPayloads] = audit.recordEventsInTransaction.mock.calls[0]!;
    expect(auditTopic).toBe('compliance.game-geo-rule.upserted');
    expect(auditPayloads).toHaveLength(2);

    const upsertPayloads = events.emit.mock.calls
      .filter(([topic]) => topic === 'compliance.game-geo-rule.upserted')
      .map(
        ([, payload]) =>
          payload as { gameId: string; before: unknown; reason: string; auditRecorded?: true },
      );
    expect(upsertPayloads).toHaveLength(2);
    expect(upsertPayloads.map((p) => p.gameId).sort()).toEqual([second, third].sort());
    expect(upsertPayloads.every((p) => p.before === null)).toBe(true);
    expect(upsertPayloads.every((p) => p.auditRecorded === true)).toBe(true);

    const firstRule = await db.drizzle.db
      .select()
      .from(gameGeoRule)
      .where(eq(gameGeoRule.gameId, first!));
    expect(firstRule).toHaveLength(1);
    expect(firstRule[0]?.reason).toBe('original reason');
  });

  it('restrict is idempotent: re-running the same call changes nothing and emits nothing', async () => {
    const providerId = await seedProvider();
    const [first, second] = await seedManyGames(providerId, 2);
    const actorId = randomUUID();
    const { svc, events } = makeService();
    await svc.bulkRestrictGameGeoRules(
      { gameIds: [first!, second!], countryCode: 'DK', reason: 'bulk restriction' },
      actorId,
      NO_META,
    );
    events.emit.mockClear();

    const result = await svc.bulkRestrictGameGeoRules(
      { gameIds: [first!, second!], countryCode: 'DK', reason: 'repeat' },
      actorId,
      NO_META,
    );

    expect(result).toEqual({
      changed: 0,
      unchanged: 2,
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('unrestricts every game of a provider, reporting the ones still blocked by the provider rule', async () => {
    const providerId = await seedProvider();
    const gameIds = await seedManyGames(providerId, 3);
    const actorId = randomUUID();
    const { svc, events, audit } = makeService();
    await svc.bulkRestrictGameGeoRules(
      { gameIds, countryCode: 'DK', reason: 'restricted' },
      actorId,
      NO_META,
    );
    await db.drizzle.db
      .insert(providerGeoRule)
      .values({ providerId, countryCode: 'DK', reason: 'provider licence restriction' });
    events.emit.mockClear();
    audit.recordEventsInTransaction.mockClear();

    const result = await svc.bulkUnrestrictGameGeoRules(
      { providerIds: [providerId], countryCode: 'DK', reason: 'licence restored' },
      actorId,
      NO_META,
    );

    expect(result).toEqual({
      changed: 3,
      unchanged: 0,
      stillBlockedByProvider: 3,
      globallyBlocked: false,
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(audit.recordEventsInTransaction).toHaveBeenCalledTimes(1);
    const [, auditTopic, auditPayloads] = audit.recordEventsInTransaction.mock.calls[0]!;
    expect(auditTopic).toBe('compliance.game-geo-rule.deleted');
    expect(auditPayloads).toHaveLength(3);
    expect(
      await db.drizzle.db.select().from(gameGeoRule).where(inArray(gameGeoRule.gameId, gameIds)),
    ).toHaveLength(0);
    expect(
      await db.drizzle.db
        .select()
        .from(providerGeoRule)
        .where(eq(providerGeoRule.providerId, providerId)),
    ).toHaveLength(1);
    const deletePayloads = events.emit.mock.calls
      .filter(([topic]) => topic === 'compliance.game-geo-rule.deleted')
      .map(([, payload]) => payload as { gameId: string; after: unknown });
    expect(deletePayloads).toHaveLength(3);
    expect(deletePayloads.every((p) => p.after === null)).toBe(true);
  });

  it('unrestrict is idempotent: a game with no matching rule is unchanged, not an error', async () => {
    const providerId = await seedProvider();
    const [first, second] = await seedManyGames(providerId, 2);
    const actorId = randomUUID();
    const { svc, events } = makeService();
    await svc.bulkRestrictGameGeoRules(
      { gameIds: [first!], countryCode: 'DK', reason: 'restricted' },
      actorId,
      NO_META,
    );
    events.emit.mockClear();

    const result = await svc.bulkUnrestrictGameGeoRules(
      { gameIds: [first!, second!], countryCode: 'DK', reason: 'licence restored' },
      actorId,
      NO_META,
    );

    expect(result).toEqual({
      changed: 1,
      unchanged: 1,
      stillBlockedByProvider: 0,
      globallyBlocked: false,
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('reports globallyBlocked when the unrestricted country is also blocked platform-wide', async () => {
    const providerId = await seedProvider();
    const [gameId] = await seedManyGames(providerId, 1);
    const actorId = randomUUID();
    const { svc } = makeService();
    await svc.bulkRestrictGameGeoRules(
      { gameIds: [gameId!], countryCode: 'DK', reason: 'restricted' },
      actorId,
      NO_META,
    );
    await db.drizzle.db.insert(countryRule).values({ countryCode: 'DK', action: 'block' });

    const result = await svc.bulkUnrestrictGameGeoRules(
      { gameIds: [gameId!], countryCode: 'DK', reason: 'licence restored' },
      actorId,
      NO_META,
    );

    expect(result).toMatchObject({ changed: 1, globallyBlocked: true });
  });

  it('reports unknown game and provider ids in notFound while the rest applies', async () => {
    const providerId = await seedProvider();
    const [first] = await seedManyGames(providerId, 1);
    const ghostGameId = randomUUID();
    const ghostProviderId = randomUUID();
    const actorId = randomUUID();
    const { svc } = makeService();

    const result = await svc.bulkRestrictGameGeoRules(
      {
        gameIds: [first!, ghostGameId],
        providerIds: [ghostProviderId],
        countryCode: 'DK',
        reason: 'bulk restriction',
      },
      actorId,
      NO_META,
    );

    expect(result).toEqual({
      changed: 1,
      unchanged: 0,
      notFound: { gameIds: [ghostGameId], providerIds: [ghostProviderId] },
    });
  });

  it('rejects a whole-provider scope over 5,000 games and writes nothing', async () => {
    const providerId = await seedProvider();
    await seedManyGames(providerId, 5001);
    const actorId = randomUUID();
    const { svc, events } = makeService();

    await expect(
      svc.bulkRestrictGameGeoRules(
        { providerIds: [providerId], countryCode: 'DK', reason: 'bulk restriction' },
        actorId,
        NO_META,
      ),
    ).rejects.toBeInstanceOf(GeoRuleBulkTooManyGamesError);
    expect(events.emit).not.toHaveBeenCalled();
    const [row] = await db.drizzle.db.select({ n: count() }).from(gameGeoRule);
    expect(Number(row?.n)).toBe(0);
  }, 30_000);

  it('a bulk restrict and a concurrent single-target upsert for the same country both finish without deadlocking', async () => {
    const providerId = await seedProvider();
    const [bulkA, bulkB, single] = await seedManyGames(providerId, 3);
    const actorId = randomUUID();
    const { svc } = makeService();

    await expect(
      Promise.all([
        svc.bulkRestrictGameGeoRules(
          { gameIds: [bulkA!, bulkB!], countryCode: 'DK', reason: 'bulk restriction' },
          actorId,
          NO_META,
        ),
        svc.upsertGameGeoRules(
          { gameId: single!, countryCodes: ['DK'], reason: 'single restriction' },
          actorId,
          NO_META,
        ),
      ]),
    ).resolves.toBeDefined();

    const rules = await db.drizzle.db
      .select({ gameId: gameGeoRule.gameId, countryCode: gameGeoRule.countryCode })
      .from(gameGeoRule)
      .where(inArray(gameGeoRule.gameId, [bulkA!, bulkB!, single!]));
    expect(rules.map((r) => r.gameId).sort()).toEqual([bulkA, bulkB, single].sort());
    expect(rules.every((r) => r.countryCode === 'DK')).toBe(true);
  });
});

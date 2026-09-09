import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { GeoIpAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { game } from '@openora/core/casino/schema/gaming';
import { mock, makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, geoRule, gameGeoRule } from '../schema/index.js';
import { ComplianceService } from '../service/compliance.service.js';

let db: TestDb;

function makeService(countryCode?: string | null) {
  const events = makeEventBus();
  const geoIp =
    countryCode === undefined
      ? null
      : mock<GeoIpAdapter>({ lookup: vi.fn(async () => ({ countryCode })) });
  const svc = new ComplianceService(db.drizzle, events, geoIp);
  return { svc, events };
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateGaming]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${userLimit}, ${geoRule}, ${gameGeoRule}, ${game} RESTART IDENTITY CASCADE`,
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

  it('allows a resolved country that carries no rule', async () => {
    const { svc } = makeService('DE');

    expect(await svc.geoCheck('1.2.3.4')).toMatchObject({ allowed: true, countryCode: 'DE' });
  });

  it('blocks a country whose rule says block, with a reason', async () => {
    const { svc } = makeService('US');
    await db.drizzle.db.insert(geoRule).values({ countryCode: 'US', action: 'block' });

    const result = await svc.geoCheck('1.2.3.4');

    expect(result).toMatchObject({ allowed: false, countryCode: 'US' });
    expect(result.reason).toContain('US');
  });

  it('allows a country whose rule says allow', async () => {
    const { svc } = makeService('DE');
    await db.drizzle.db.insert(geoRule).values({ countryCode: 'DE', action: 'allow' });

    expect(await svc.geoCheck('1.2.3.4')).toMatchObject({ allowed: true, countryCode: 'DE' });
  });
});

describe('ComplianceService geo rules (real PG)', () => {
  it('adds a rule and emits the event', async () => {
    const { svc, events } = makeService();
    const actorId = randomUUID();

    const rule = await svc.addGeoRule({ countryCode: 'FR', action: 'block' }, actorId);

    expect(rule).toMatchObject({ countryCode: 'FR', action: 'block' });
    expect(events.emit).toHaveBeenCalledWith(
      'compliance.geo-rule.added',
      expect.objectContaining({ countryCode: 'FR', action: 'block', actorId }),
    );
  });

  it('upserts the action for a country already on file', async () => {
    const { svc } = makeService();
    await svc.addGeoRule({ countryCode: 'FR', action: 'block' });

    const updated = await svc.addGeoRule({ countryCode: 'FR', action: 'allow' });

    expect(updated.action).toBe('allow');
    expect(await db.drizzle.db.select().from(geoRule)).toHaveLength(1);
  });

  it('lists every rule on file', async () => {
    const { svc } = makeService();
    await svc.addGeoRule({ countryCode: 'FR', action: 'block' });
    await svc.addGeoRule({ countryCode: 'DE', action: 'allow' });

    const rules = await svc.listGeoRules();

    expect(rules.map((r) => r.countryCode).sort()).toEqual(['DE', 'FR']);
  });
});

describe('ComplianceService per-game geo rules (real PG)', () => {
  it('lets a global block win before the game-specific decision', async () => {
    const { svc } = makeService('US');
    await db.drizzle.db.insert(geoRule).values({ countryCode: 'US', action: 'block' });

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

  it('allows unresolved geo when only a global rule exists', async () => {
    const gameId = '00000000-0000-0000-0000-000000000119';
    const { svc } = makeService(null);
    await db.drizzle.db.insert(geoRule).values({ countryCode: 'US', action: 'block' });

    await expect(svc.checkGame({ gameId, ipAddress: '1.2.3.4' })).resolves.toEqual({
      allowed: true,
      countryCode: null,
      reason: null,
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
    await db.drizzle.db
      .insert(game)
      .values({ id: gameId, name: 'Game', provider: 'mock', category: 'slots' });

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
    await db.drizzle.db.insert(game).values({
      id: gameId,
      name: 'Concurrent Game',
      provider: 'mock',
      category: 'slots',
    });

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

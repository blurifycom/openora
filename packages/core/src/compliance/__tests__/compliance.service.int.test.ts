import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { GeoIpAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { mock, makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, geoRule } from '../schema/index.js';
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
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${userLimit}, ${geoRule} RESTART IDENTITY CASCADE`);
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

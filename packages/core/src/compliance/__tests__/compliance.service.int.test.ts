import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { GeoIpAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { mock, makeEventBus, makeIdentityReader } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, geoRule } from '../schema/index.js';
import {
  ComplianceService,
  LimitNotFoundError,
  LimitOwnershipError,
} from '../service/compliance.service.js';

let db: TestDb;

function makeService(countryCode?: string | null) {
  const events = makeEventBus();
  const geoIp =
    countryCode === undefined
      ? null
      : mock<GeoIpAdapter>({ lookup: vi.fn(async () => ({ countryCode })) });
  const svc = new ComplianceService(db.drizzle, events, geoIp, makeIdentityReader());
  return { svc, events };
}

async function seedLimit(userId: string, overrides: Partial<typeof userLimit.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(userLimit)
    .values({
      userId,
      type: 'deposit',
      amount: '100',
      minutes: null,
      period: 'daily',
      ...overrides,
    })
    .returning();
  return row!;
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

describe('ComplianceService limits (real PG)', () => {
  it('returns an empty list for a player with no limits', async () => {
    const { svc } = makeService();

    expect(await svc.getLimitsForUser(randomUUID())).toEqual([]);
  });

  it('returns only the requesting player rows, with serialized timestamps', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedLimit(userId);
    await seedLimit(randomUUID());

    const limits = await svc.getLimitsForUser(userId);

    expect(limits).toHaveLength(1);
    expect(typeof limits[0]?.createdAt).toBe('string');
  });

  it('inserts a limit and emits upserted', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();

    const limit = await svc.upsertLimit(userId, {
      type: 'deposit',
      amount: '100',
      minutes: null,
      period: 'daily',
    });

    expect(Number(limit.amount)).toBe(100);
    expect(events.emit).toHaveBeenCalledWith(
      'compliance.limit.upserted',
      expect.objectContaining({ userId, limitId: limit.id }),
    );
  });

  it('upserts in place on the same type and period', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const first = await svc.upsertLimit(userId, {
      type: 'deposit',
      amount: '100',
      minutes: null,
      period: 'daily',
    });

    const second = await svc.upsertLimit(userId, {
      type: 'deposit',
      amount: '250',
      minutes: null,
      period: 'daily',
    });

    expect(second.id).toBe(first.id);
    const rows = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.amount)).toBe(250);
  });

  it('removes an owned limit and emits removed', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    const limit = await seedLimit(userId);

    await expect(svc.removeLimit(limit.id, userId)).resolves.toEqual({ success: true });

    expect(await db.drizzle.db.select().from(userLimit)).toHaveLength(0);
    expect(events.emit).toHaveBeenCalledWith(
      'compliance.limit.removed',
      expect.objectContaining({ userId, limitId: limit.id }),
    );
  });

  it('throws LimitNotFoundError for an unknown id', async () => {
    const { svc } = makeService();

    await expect(svc.removeLimit(randomUUID(), randomUUID())).rejects.toBeInstanceOf(
      LimitNotFoundError,
    );
  });

  it('refuses to remove another players limit and leaves the row in place', async () => {
    const { svc, events } = makeService();
    const owner = randomUUID();
    const limit = await seedLimit(owner);

    await expect(svc.removeLimit(limit.id, randomUUID())).rejects.toBeInstanceOf(
      LimitOwnershipError,
    );
    expect(await db.drizzle.db.select().from(userLimit)).toHaveLength(1);
    expect(events.emit).not.toHaveBeenCalled();
  });
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

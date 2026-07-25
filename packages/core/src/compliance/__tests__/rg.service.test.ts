import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type {
  AdminPlayerSummary,
  AdminUserDirectory,
  LoginEnforcementPort,
  SendEmailPort,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock, makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, rgExclusion } from '../schema/index.js';
import {
  RgService,
  ActiveExclusionError,
  PermanentExclusionLiftError,
  ExclusionPeriodNotElapsedError,
  ExclusionNotFoundError,
} from '../service/rg.service.js';

let db: TestDb;

type Notifier = { email: SendEmailPort; directory: AdminUserDirectory };

function makeNotifier(email = 'player@example.com'): Notifier {
  return {
    email: mock<SendEmailPort>({ send: vi.fn(async () => undefined) }),
    directory: mock<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (ids: string[]) =>
        ids.map((userId) => mock<AdminPlayerSummary>({ userId, email })),
      ),
    }),
  };
}

function makeService(notifier?: Notifier) {
  const events = makeEventBus();
  const enforcement = mock<LoginEnforcementPort>({
    block: vi.fn(async () => undefined),
    unblock: vi.fn(async () => undefined),
  });
  const svc = new RgService({
    drizzle: db.drizzle,
    events: events,
    loginEnforcement: enforcement,
    email: notifier?.email ?? null,
    directory: notifier?.directory ?? null,
  });
  return { svc, events, enforcement };
}

async function seedExclusion(overrides: Partial<typeof rgExclusion.$inferInsert>) {
  const [row] = await db.drizzle.db
    .insert(rgExclusion)
    .values({
      userId: randomUUID(),
      kind: 'self_exclusion',
      status: 'active',
      reason: 'gambling concern',
      isPermanent: false,
      createdBy: randomUUID(),
      ...overrides,
    })
    .returning();
  return row!;
}

async function exclusionsOf(userId: string) {
  return db.drizzle.db.select().from(rgExclusion).where(eq(rgExclusion.userId, userId));
}

const HOURS = 3600_000;
const future = () => new Date(Date.now() + 200 * 24 * HOURS);
const past = () => new Date(Date.now() - 1000);

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${rgExclusion}, ${userLimit} RESTART IDENTITY CASCADE`);
});

describe('RgService.setPlayerLimit (real PG)', () => {
  it('persists a first limit and reports no prior amount', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();

    const dto = await svc.setPlayerLimit(
      userId,
      { userId, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      actorId,
    );

    expect(Number(dto.amount)).toBe(100);
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.set',
      expect.objectContaining({ userId, actorId, amount: '100', previousAmount: null }),
    );
  });

  it('upserts on the same type and period, carrying the prior amount into the event', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();
    await svc.setPlayerLimit(
      userId,
      { userId, type: 'deposit', amount: '50', minutes: null, period: 'daily' },
      actorId,
    );

    await svc.setPlayerLimit(
      userId,
      { userId, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      actorId,
    );

    const rows = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.amount)).toBe(100);
    expect(events.emit).toHaveBeenLastCalledWith(
      'rg.limit.set',
      expect.objectContaining({ previousAmount: '50.00' }),
    );
  });

  it('keeps a different period as its own row', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();

    await svc.setPlayerLimit(
      userId,
      { userId, type: 'deposit', amount: '50', minutes: null, period: 'daily' },
      actorId,
    );
    await svc.setPlayerLimit(
      userId,
      { userId, type: 'deposit', amount: '500', minutes: null, period: 'monthly' },
      actorId,
    );

    const rows = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(rows).toHaveLength(2);
  });

  it('stores minutes and no amount for a session limit', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    const dto = await svc.setPlayerLimit(
      userId,
      { userId, type: 'session', amount: null, minutes: 60, period: 'session' },
      randomUUID(),
    );

    expect(dto).toMatchObject({ minutes: 60, amount: null });
  });

  it('emails the player when a mail port and directory are bound', async () => {
    const notifier = makeNotifier();
    const { svc } = makeService(notifier);
    const userId = randomUUID();

    await svc.setPlayerLimit(
      userId,
      { userId, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      randomUUID(),
    );

    expect(notifier.email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'player@example.com' }),
    );
  });

  it('swallows a notification failure once the limit has committed', async () => {
    const notifier = makeNotifier();
    vi.mocked(notifier.email.send).mockRejectedValueOnce(new Error('smtp down'));
    const { svc } = makeService(notifier);
    const userId = randomUUID();

    await expect(
      svc.setPlayerLimit(
        userId,
        { userId, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ period: 'daily' });
    const rows = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(rows).toHaveLength(1);
  });
});

describe('RgService.activateCoolingOff (real PG)', () => {
  it('stores an active row and blocks login until its expiry', async () => {
    const { svc, events, enforcement } = makeService();
    const userId = randomUUID();

    await svc.activateCoolingOff(
      userId,
      { userId, durationHours: 24, reason: 'break' },
      randomUUID(),
    );

    const [row] = await exclusionsOf(userId);
    expect(row).toMatchObject({ kind: 'cooling_off', status: 'active', isPermanent: false });
    expect(enforcement.block).toHaveBeenCalledWith(userId, { until: expect.any(Date) });
    expect(enforcement.unblock).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.cooling_off.activated',
      expect.objectContaining({ userId }),
    );
  });

  it('rejects a second cooling-off while one is still running', async () => {
    const { svc, enforcement } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, kind: 'cooling_off', expiresAt: future() });

    await expect(
      svc.activateCoolingOff(userId, { userId, durationHours: 24, reason: 'break' }, randomUUID()),
    ).rejects.toBeInstanceOf(ActiveExclusionError);
    expect(enforcement.block).not.toHaveBeenCalled();
  });

  it('expires a lapsed cooling-off and lets a fresh one through', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const lapsed = await seedExclusion({ userId, kind: 'cooling_off', expiresAt: past() });

    await svc.activateCoolingOff(
      userId,
      { userId, durationHours: 24, reason: 'again' },
      randomUUID(),
    );

    const rows = await exclusionsOf(userId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === lapsed.id)?.status).toBe('expired');
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });

  it('keeps an indefinite block when a self-exclusion is still active', async () => {
    const { svc, enforcement } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, kind: 'self_exclusion', isPermanent: true, expiresAt: null });

    await svc.activateCoolingOff(
      userId,
      { userId, durationHours: 24, reason: 'break' },
      randomUUID(),
    );

    expect(enforcement.block).toHaveBeenCalledWith(userId, { until: null });
  });
});

describe('RgService.activateSelfExclusion (real PG)', () => {
  it('stores a permanent exclusion with no expiry and blocks indefinitely', async () => {
    const { svc, events, enforcement } = makeService();
    const userId = randomUUID();

    await svc.activateSelfExclusion(
      userId,
      { userId, isPermanent: true, reason: 'stop', confirm: true },
      randomUUID(),
    );

    const [row] = await exclusionsOf(userId);
    expect(row).toMatchObject({ kind: 'self_exclusion', isPermanent: true, expiresAt: null });
    expect(enforcement.block).toHaveBeenCalledWith(userId, { until: null });
    expect(events.emit).toHaveBeenCalledWith(
      'rg.self_exclusion.activated',
      expect.objectContaining({ isPermanent: true, expiresAt: null }),
    );
  });

  it('stores a fixed-term expiry but still blocks indefinitely', async () => {
    const { svc, enforcement } = makeService();
    const userId = randomUUID();

    await svc.activateSelfExclusion(
      userId,
      { userId, isPermanent: false, durationMonths: 6, reason: 'break', confirm: true },
      randomUUID(),
    );

    const [row] = await exclusionsOf(userId);
    expect(row?.expiresAt).toBeInstanceOf(Date);
    expect(enforcement.block).toHaveBeenCalledWith(userId, { until: null });
  });

  it('rejects a second active self-exclusion', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, kind: 'self_exclusion', isPermanent: true });

    await expect(
      svc.activateSelfExclusion(
        userId,
        { userId, isPermanent: true, reason: 'again', confirm: true },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ActiveExclusionError);
  });
});

describe('RgService.liftSelfExclusion (real PG)', () => {
  it('refuses to lift a permanent self-exclusion', async () => {
    const { svc, enforcement } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, isPermanent: true, expiresAt: null });

    await expect(
      svc.liftSelfExclusion(userId, { userId, reason: 'ok', confirm: true }, randomUUID()),
    ).rejects.toBeInstanceOf(PermanentExclusionLiftError);
    expect(enforcement.unblock).not.toHaveBeenCalled();
  });

  it('refuses to lift before the minimum period has elapsed', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, isPermanent: false, expiresAt: future() });

    await expect(
      svc.liftSelfExclusion(userId, { userId, reason: 'ok', confirm: true }, randomUUID()),
    ).rejects.toBeInstanceOf(ExclusionPeriodNotElapsedError);
  });

  it('throws when the player has no active self-exclusion', async () => {
    const { svc } = makeService();

    await expect(
      svc.liftSelfExclusion(
        randomUUID(),
        { userId: randomUUID(), reason: 'ok', confirm: true },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ExclusionNotFoundError);
  });

  it('lifts an elapsed exclusion, records the lift metadata, and unblocks', async () => {
    const { svc, events, enforcement } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();
    const existing = await seedExclusion({ userId, isPermanent: false, expiresAt: past() });

    await svc.liftSelfExclusion(userId, { userId, reason: 'recovered', confirm: true }, actorId);

    const [row] = await exclusionsOf(userId);
    expect(row).toMatchObject({
      id: existing.id,
      status: 'lifted',
      liftedReason: 'recovered',
      liftedBy: actorId,
    });
    expect(row?.liftedAt).toBeInstanceOf(Date);
    expect(enforcement.unblock).toHaveBeenCalledWith(userId);
    expect(events.emit).toHaveBeenCalledWith(
      'rg.self_exclusion.lifted',
      expect.objectContaining({ userId, actorId }),
    );
  });

  it('recomputes to the remaining cooling-off block instead of unblocking', async () => {
    const { svc, enforcement } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, isPermanent: false, expiresAt: past() });
    await seedExclusion({ userId, kind: 'cooling_off', expiresAt: future() });

    await svc.liftSelfExclusion(userId, { userId, reason: 'ok', confirm: true }, randomUUID());

    expect(enforcement.block).toHaveBeenCalledWith(userId, { until: expect.any(Date) });
    expect(enforcement.unblock).not.toHaveBeenCalled();
  });

  it('lets a fresh self-exclusion start once the previous one was lifted', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, isPermanent: false, expiresAt: past() });
    await svc.liftSelfExclusion(userId, { userId, reason: 'ok', confirm: true }, randomUUID());

    await svc.activateSelfExclusion(
      userId,
      { userId, isPermanent: true, reason: 'relapse', confirm: true },
      randomUUID(),
    );

    const rows = await exclusionsOf(userId);
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });
});

describe('RgService.getRgSection (real PG)', () => {
  it('returns the player limits alongside the active exclusions', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.setPlayerLimit(
      userId,
      { userId, type: 'deposit', amount: '100', minutes: null, period: 'daily' },
      randomUUID(),
    );
    await seedExclusion({ userId, kind: 'cooling_off', expiresAt: future() });
    await seedExclusion({ userId, kind: 'self_exclusion', isPermanent: true });

    const section = await svc.getRgSection(userId);

    expect(section.limits).toHaveLength(1);
    expect(section.coolingOff).toMatchObject({ kind: 'cooling_off' });
    expect(section.selfExclusion).toMatchObject({ kind: 'self_exclusion' });
  });

  it('treats a lapsed cooling-off as inactive even before the sweep runs', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, kind: 'cooling_off', expiresAt: past() });

    const section = await svc.getRgSection(userId);

    expect(section.coolingOff).toBeNull();
  });

  it('returns empty state for a player with nothing on file', async () => {
    const { svc } = makeService();

    const section = await svc.getRgSection(randomUUID());

    expect(section).toEqual({ limits: [], coolingOff: null, selfExclusion: null });
  });
});

describe('RgService.expireLapsedCoolingOffs (real PG)', () => {
  it('expires lapsed rows and unblocks the affected players', async () => {
    const { svc, enforcement } = makeService();
    const lapsedUser = randomUUID();
    const runningUser = randomUUID();
    await seedExclusion({ userId: lapsedUser, kind: 'cooling_off', expiresAt: past() });
    await seedExclusion({ userId: runningUser, kind: 'cooling_off', expiresAt: future() });

    await svc.expireLapsedCoolingOffs();

    const [lapsed] = await exclusionsOf(lapsedUser);
    const [running] = await exclusionsOf(runningUser);
    expect(lapsed?.status).toBe('expired');
    expect(running?.status).toBe('active');
    expect(enforcement.unblock).toHaveBeenCalledWith(lapsedUser);
    expect(enforcement.unblock).not.toHaveBeenCalledWith(runningUser);
  });

  it('keeps the indefinite block when the player is also self-excluded', async () => {
    const { svc, enforcement } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, kind: 'cooling_off', expiresAt: past() });
    await seedExclusion({ userId, kind: 'self_exclusion', isPermanent: true });

    await svc.expireLapsedCoolingOffs();

    expect(enforcement.block).toHaveBeenCalledWith(userId, { until: null });
    expect(enforcement.unblock).not.toHaveBeenCalled();
  });
});

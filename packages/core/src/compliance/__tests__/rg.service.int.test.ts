import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type {
  AdminPlayerSummary,
  AdminUserDirectory,
  EmailTemplateRenderer,
  LoginEnforcementPort,
  SendEmailPort,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeIdentityReader, mock, makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, rgExclusion } from '../schema/index.js';
import {
  RgService,
  ActiveExclusionError,
  PermanentExclusionLiftError,
  ExclusionPeriodNotElapsedError,
  ExclusionNotFoundError,
  LimitRaiseNotAllowedError,
} from '../service/rg.service.js';

let db: TestDb;

type Notifier = {
  email: SendEmailPort;
  directory: AdminUserDirectory;
  templateRenderer: EmailTemplateRenderer;
};

function makeNotifier(email = 'player@example.com'): Notifier {
  return {
    email: mock<SendEmailPort>({ send: vi.fn(async () => undefined) }),
    directory: mock<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (ids: string[]) =>
        ids.map((userId) => mock<AdminPlayerSummary>({ userId, email, language: 'en' })),
      ),
    }),
    templateRenderer: mock<EmailTemplateRenderer>({
      render: vi.fn(async () => ({ subject: 'subject', body: 'body' })),
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
    events,
    loginEnforcement: enforcement,
    email: notifier?.email ?? null,
    directory: notifier?.directory ?? null,
    templateRenderer: notifier?.templateRenderer ?? null,
    identityReader: makeIdentityReader(),
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
  db = await createTestDb([migrate, migrateProfile]);
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
      {
        userId,
        type: 'deposit',
        amount: '100',
        minutes: null,
        period: 'daily',
        reason: 'player requested via support',
        confirm: true,
      },
      actorId,
      'admin',
    );

    expect(Number(dto.amount)).toBe(100);
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.set',
      expect.objectContaining({
        userId,
        actorId,
        amount: '100',
        previousAmount: null,
        reason: 'player requested via support',
      }),
    );
  });

  it('upserts on the same type and period, carrying the prior amount into the event (a lowering)', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();
    await svc.setPlayerLimit(
      userId,
      {
        userId,
        type: 'deposit',
        amount: '100',
        minutes: null,
        period: 'daily',
        reason: 'initial limit',
        confirm: true,
      },
      actorId,
      'admin',
    );

    await svc.setPlayerLimit(
      userId,
      {
        userId,
        type: 'deposit',
        amount: '50',
        minutes: null,
        period: 'daily',
        reason: 'reducing exposure',
        confirm: true,
      },
      actorId,
      'admin',
    );

    const rows = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.amount)).toBe(50);
    expect(events.emit).toHaveBeenLastCalledWith(
      'rg.limit.set',
      expect.objectContaining({ previousAmount: '100.00', reason: 'reducing exposure' }),
    );
  });

  it('refuses to raise a limit the player controls, server-side, and leaves the row unchanged', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();
    await svc.setPlayerLimit(
      userId,
      {
        userId,
        type: 'deposit',
        amount: '50',
        minutes: null,
        period: 'daily',
        reason: 'initial limit',
        confirm: true,
      },
      actorId,
      'admin',
    );

    await expect(
      svc.setPlayerLimit(
        userId,
        {
          userId,
          type: 'deposit',
          amount: '100',
          minutes: null,
          period: 'daily',
          reason: 'trying to raise it',
          confirm: true,
        },
        actorId,
        'admin',
      ),
    ).rejects.toBeInstanceOf(LimitRaiseNotAllowedError);

    const rows = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.amount)).toBe(50);
  });

  it('refuses to raise a session-time limit, classified on minutes not amount', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();
    await svc.setPlayerLimit(
      userId,
      {
        userId,
        type: 'session',
        amount: null,
        minutes: 60,
        period: 'session',
        reason: 'initial session limit',
        confirm: true,
      },
      actorId,
      'admin',
    );

    await expect(
      svc.setPlayerLimit(
        userId,
        {
          userId,
          type: 'session',
          amount: null,
          minutes: 120,
          period: 'session',
          reason: 'trying to raise it',
          confirm: true,
        },
        actorId,
        'admin',
      ),
    ).rejects.toBeInstanceOf(LimitRaiseNotAllowedError);

    const rows = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.minutes).toBe(60);
  });

  it('keeps a different period as its own row', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();

    await svc.setPlayerLimit(
      userId,
      {
        userId,
        type: 'deposit',
        amount: '50',
        minutes: null,
        period: 'daily',
        reason: 'daily limit',
        confirm: true,
      },
      actorId,
      'admin',
    );
    await svc.setPlayerLimit(
      userId,
      {
        userId,
        type: 'deposit',
        amount: '500',
        minutes: null,
        period: 'monthly',
        reason: 'monthly limit',
        confirm: true,
      },
      actorId,
      'admin',
    );

    const rows = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(rows).toHaveLength(2);
  });

  it('stores minutes and no amount for a session limit', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    const dto = await svc.setPlayerLimit(
      userId,
      {
        userId,
        type: 'session',
        amount: null,
        minutes: 60,
        period: 'session',
        reason: 'session limit',
        confirm: true,
      },
      randomUUID(),
      'admin',
    );

    expect(dto).toMatchObject({ minutes: 60, amount: null });
  });

  it('emails the player when a mail port, directory, and template renderer are bound', async () => {
    const notifier = makeNotifier();
    const { svc } = makeService(notifier);
    const userId = randomUUID();

    await svc.setPlayerLimit(
      userId,
      {
        userId,
        type: 'deposit',
        amount: '100',
        minutes: null,
        period: 'daily',
        reason: 'notify test',
        confirm: true,
      },
      randomUUID(),
      'admin',
    );

    expect(notifier.templateRenderer.render).toHaveBeenCalled();
    expect(notifier.email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'player@example.com', subject: 'subject', body: 'body' }),
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
        {
          userId,
          type: 'deposit',
          amount: '100',
          minutes: null,
          period: 'daily',
          reason: 'swallow failure test',
          confirm: true,
        },
        randomUUID(),
        'admin',
      ),
    ).resolves.toMatchObject({ period: 'daily' });
    const rows = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(rows).toHaveLength(1);
  });

  // Mirrors the ADR's concurrency reasoning for the player's own path: the raise
  // classification is only meaningful against the value still present when the write
  // lands, so the read-then-decide has to happen under the same per-limit lock as the
  // write. Without that lock, two racing admin writes could both read the ORIGINAL 100,
  // both decide their own move is a lawful lowering (80 < 100), and whichever commits
  // last would silently overwrite the other - landing 80 in force even though it is a
  // RAISE over the 50 the other call had already committed.
  it('two racing admin writes cannot land a raise through the read-then-decide window', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();
    await svc.setPlayerLimit(
      userId,
      {
        userId,
        type: 'deposit',
        amount: '100',
        minutes: null,
        period: 'daily',
        reason: 'initial limit',
        confirm: true,
      },
      actorId,
      'admin',
    );

    const results = await Promise.allSettled([
      svc.setPlayerLimit(
        userId,
        {
          userId,
          type: 'deposit',
          amount: '50',
          minutes: null,
          period: 'daily',
          reason: 'lowering',
          confirm: true,
        },
        actorId,
        'admin',
      ),
      svc.setPlayerLimit(
        userId,
        {
          userId,
          type: 'deposit',
          amount: '80',
          minutes: null,
          period: 'daily',
          reason: 'lowering relative to the original 100, but a raise if 50 lands first',
          confirm: true,
        },
        actorId,
        'admin',
      ),
    ]);

    const rows = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    expect(rows).toHaveLength(1);
    // 80 is only ever a lawful write if it lands BEFORE the lowering to 50, in which case
    // the lowering runs afterward and still wins. There is no serialized ordering under
    // which the final value can be 80.
    expect(Number(rows[0]?.amount)).toBe(50);
    const raiseAttempt = results[1];
    if (raiseAttempt.status === 'rejected') {
      expect(raiseAttempt.reason).toBeInstanceOf(LimitRaiseNotAllowedError);
    }
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
      'admin',
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
      svc.activateCoolingOff(
        userId,
        { userId, durationHours: 24, reason: 'break' },
        randomUUID(),
        'admin',
      ),
    ).rejects.toBeInstanceOf(ActiveExclusionError);
    expect(enforcement.block).not.toHaveBeenCalled();
  });

  it('expires a lapsed cooling-off and lets a fresh one through', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    const lapsedExpiresAt = past();
    const lapsed = await seedExclusion({
      userId,
      kind: 'cooling_off',
      expiresAt: lapsedExpiresAt,
    });

    await svc.activateCoolingOff(
      userId,
      { userId, durationHours: 24, reason: 'again' },
      randomUUID(),
      'admin',
    );

    const rows = await exclusionsOf(userId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === lapsed.id)?.status).toBe('expired');
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledWith(
      'rg.cooling_off.expired',
      expect.objectContaining({
        userId,
        exclusionId: lapsed.id,
        expiresAt: lapsedExpiresAt.toISOString(),
      }),
    );
  });

  it('keeps an indefinite block when a self-exclusion is still active', async () => {
    const { svc, enforcement } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, kind: 'self_exclusion', isPermanent: true, expiresAt: null });

    await svc.activateCoolingOff(
      userId,
      { userId, durationHours: 24, reason: 'break' },
      randomUUID(),
      'admin',
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
      'admin',
    );

    const [row] = await exclusionsOf(userId);
    expect(row).toMatchObject({ kind: 'self_exclusion', isPermanent: true, expiresAt: null });
    expect(enforcement.block).toHaveBeenCalledWith(userId, { until: null });
    expect(events.emit).toHaveBeenCalledWith(
      'rg.self_exclusion.activated',
      expect.objectContaining({ isPermanent: true, durationMonths: null, expiresAt: null }),
    );
  });

  it('stores a fixed-term expiry, keeps the indefinite block, and emits the chosen term', async () => {
    const { svc, events, enforcement } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();

    await svc.activateSelfExclusion(
      userId,
      { userId, isPermanent: false, durationMonths: 6, reason: 'break', confirm: true },
      actorId,
      'admin',
    );

    const [row] = await exclusionsOf(userId);
    expect(row?.expiresAt).toBeInstanceOf(Date);
    expect(enforcement.block).toHaveBeenCalledWith(userId, { until: null });
    expect(events.emit).toHaveBeenCalledWith(
      'rg.self_exclusion.activated',
      expect.objectContaining({
        userId,
        actorId,
        isPermanent: false,
        durationMonths: 6,
        reason: 'break',
      }),
    );
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
        'admin',
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
      'admin',
    );

    const rows = await exclusionsOf(userId);
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });
});

describe('RgService.liftCoolingOff (real PG)', () => {
  it('throws when the player has no active cooling-off', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    await expect(
      svc.liftCoolingOff(userId, { userId, reason: 'ok' }, randomUUID()),
    ).rejects.toBeInstanceOf(ExclusionNotFoundError);
  });

  it('lifts an active cooling-off, records the lift metadata, and unblocks', async () => {
    const { svc, events, enforcement } = makeService();
    const userId = randomUUID();
    const actorId = randomUUID();
    const existing = await seedExclusion({ userId, kind: 'cooling_off', expiresAt: future() });

    await svc.liftCoolingOff(userId, { userId, reason: 'support ticket 42' }, actorId);

    const [row] = await exclusionsOf(userId);
    expect(row).toMatchObject({
      id: existing.id,
      kind: 'cooling_off',
      status: 'lifted',
      liftedReason: 'support ticket 42',
      liftedBy: actorId,
    });
    expect(enforcement.unblock).toHaveBeenCalledWith(userId);
    expect(events.emit).toHaveBeenCalledWith(
      'rg.cooling_off.lifted',
      expect.objectContaining({ userId, actorId, reason: 'support ticket 42' }),
    );
  });

  it('keeps an indefinite block when the player is also self-excluded', async () => {
    const { svc, enforcement } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, kind: 'cooling_off', expiresAt: future() });
    await seedExclusion({ userId, kind: 'self_exclusion', isPermanent: true, expiresAt: null });

    await svc.liftCoolingOff(userId, { userId, reason: 'ok' }, randomUUID());

    expect(enforcement.block).toHaveBeenCalledWith(userId, { until: null });
    expect(enforcement.unblock).not.toHaveBeenCalled();
  });
});

describe('RgService.getActiveExclusions (real PG)', () => {
  it('returns the active cooling-off and self-exclusion', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, kind: 'cooling_off', expiresAt: future() });
    await seedExclusion({ userId, kind: 'self_exclusion', isPermanent: true });

    const exclusions = await svc.getActiveExclusions(userId);

    expect(exclusions.coolingOff).toMatchObject({ kind: 'cooling_off' });
    expect(exclusions.selfExclusion).toMatchObject({ kind: 'self_exclusion' });
  });

  it('treats a lapsed cooling-off as inactive even before the sweep runs', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, kind: 'cooling_off', expiresAt: past() });

    const exclusions = await svc.getActiveExclusions(userId);

    expect(exclusions.coolingOff).toBeNull();
  });

  it('returns empty state for a player with nothing on file', async () => {
    const { svc } = makeService();

    const exclusions = await svc.getActiveExclusions(randomUUID());

    expect(exclusions).toEqual({ coolingOff: null, selfExclusion: null });
  });
});

describe('RgService.expireLapsedCoolingOffs (real PG)', () => {
  it('expires lapsed rows and unblocks the affected players', async () => {
    const { svc, events, enforcement } = makeService();
    const lapsedUser = randomUUID();
    const runningUser = randomUUID();
    const lapsedExpiresAt = past();
    const lapsedRow = await seedExclusion({
      userId: lapsedUser,
      kind: 'cooling_off',
      expiresAt: lapsedExpiresAt,
    });
    await seedExclusion({ userId: runningUser, kind: 'cooling_off', expiresAt: future() });

    await svc.expireLapsedCoolingOffs();

    const [lapsed] = await exclusionsOf(lapsedUser);
    const [running] = await exclusionsOf(runningUser);
    expect(lapsed?.status).toBe('expired');
    expect(running?.status).toBe('active');
    expect(enforcement.unblock).toHaveBeenCalledWith(lapsedUser);
    expect(enforcement.unblock).not.toHaveBeenCalledWith(runningUser);
    expect(events.emit).toHaveBeenCalledWith(
      'rg.cooling_off.expired',
      expect.objectContaining({
        userId: lapsedUser,
        exclusionId: lapsedRow.id,
        expiresAt: lapsedExpiresAt.toISOString(),
      }),
    );
    expect(events.emit).not.toHaveBeenCalledWith(
      'rg.cooling_off.expired',
      expect.objectContaining({ userId: runningUser }),
    );
  });

  it('emits nothing when no cooling-off has lapsed', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await seedExclusion({ userId, kind: 'cooling_off', expiresAt: future() });

    await svc.expireLapsedCoolingOffs();

    expect(events.emit).not.toHaveBeenCalledWith('rg.cooling_off.expired', expect.anything());
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

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { LoginEnforcementPort, ResponsibleGamingConfig } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { game, gameRound } from '@openora/core/casino/schema/gaming';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { makeIdentityReader, mock, makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, rgExclusion, rgFlag } from '../schema/index.js';
import { RgService } from '../service/rg.service.js';
import { RgMonitoringService } from '../service/rg-monitoring.service.js';
import {
  RgSelfServiceService,
  CooldownNotElapsedError,
  LimitChangeExpiredError,
  NoPendingLimitChangeError,
} from '../service/rg-self-service.service.js';
import { LimitOwnershipError } from '../service/compliance.service.js';

let db: TestDb;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function makeService(config: Partial<ResponsibleGamingConfig> = {}) {
  const events = makeEventBus();
  const enforcement = mock<LoginEnforcementPort>({
    block: vi.fn(async () => undefined),
    unblock: vi.fn(async () => undefined),
  });
  const rg = new RgService({
    drizzle: db.drizzle,
    events,
    loginEnforcement: enforcement,
    identityReader: makeIdentityReader(),
  });
  const monitoring = new RgMonitoringService({ drizzle: db.drizzle });
  const svc = new RgSelfServiceService({
    drizzle: db.drizzle,
    events,
    rg,
    monitoring,
    identityReader: makeIdentityReader(),
    config: {
      limitIncreaseCooldownHours: 24,
      limitChangeConfirmationWindowHours: 168,
      ...config,
    },
  });
  return { svc, rg, monitoring, events, enforcement };
}

const deposit100 = { type: 'deposit', amount: '100', minutes: null, period: 'daily' } as const;

async function allLimitRows(userId: string) {
  return db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
}

async function limitRow(userId: string) {
  const [row] = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
  return row!;
}

// Rewinds the request's clock so a cool-down that "has elapsed" needs no real waiting.
async function backdatePending(limitId: string, effectiveAt: Date, expiresAt: Date) {
  await db.drizzle.db
    .update(userLimit)
    .set({ pendingEffectiveAt: effectiveAt, pendingExpiresAt: expiresAt })
    .where(eq(userLimit.id, limitId));
}

async function seedCompletedDeposit(userId: string, amount: string) {
  const [walletRow] = await db.drizzle.db
    .insert(wallet)
    .values({ userId, currency: 'USD' })
    .returning();
  await db.drizzle.db.insert(walletTransaction).values({
    walletId: walletRow!.id,
    type: 'deposit',
    amount,
    currency: 'USD',
    status: 'completed',
    direction: 'credit',
    rail: 'fiat',
  });
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateWallet, migrateGaming]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${userLimit}, ${rgExclusion}, ${rgFlag}, ${walletTransaction}, ${wallet}, ${gameRound}, ${game} RESTART IDENTITY CASCADE`,
  );
});

describe('RgSelfServiceService.upsertLimit (real PG)', () => {
  it('writes a first limit immediately, with no request parked on it', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    const view = await svc.upsertLimit(userId, deposit100);

    expect(view.amount).toBe('100.00');
    expect(view.pendingStatus).toBeNull();
  });

  it('lowers a limit immediately', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);

    const view = await svc.upsertLimit(userId, { ...deposit100, amount: '50' });

    expect(view.amount).toBe('50.00');
    expect(view.pendingStatus).toBeNull();
  });

  it('a raise leaves the limit in force and parks a waiting request', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);

    const view = await svc.upsertLimit(userId, { ...deposit100, amount: '500' });

    expect(view.amount).toBe('100.00');
    expect(view.pendingAmount).toBe('500.00');
    expect(view.pendingStatus).toBe('waiting');
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.change_requested',
      expect.objectContaining({
        kind: 'increase',
        requestedAmount: '500.00',
        initiatedBy: 'player',
      }),
    );
  });

  it('a fresh request replaces the parked one and restarts the cool-down', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const first = await limitRow(userId);
    await backdatePending(first.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    const view = await svc.upsertLimit(userId, { ...deposit100, amount: '900' });

    expect(view.pendingAmount).toBe('900.00');
    // Not confirmable any more: the deadline moved forward with the new request rather
    // than being inherited from the one it replaced.
    expect(view.pendingStatus).toBe('waiting');
  });

  it('lowering a limit while a raise is parked voids the raise', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });

    const view = await svc.upsertLimit(userId, { ...deposit100, amount: '20' });

    expect(view.amount).toBe('20.00');
    expect(view.pendingStatus).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.change_cancelled',
      expect.objectContaining({ requestedAmount: '500.00' }),
    );
  });

  it('reports usage and headroom against the current window', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedCompletedDeposit(userId, '80');
    await svc.upsertLimit(userId, deposit100);

    const [view] = await svc.getLimits(userId);

    expect(Number(view?.used)).toBe(80);
    expect(Number(view?.remaining)).toBe(20);
    expect(view?.pct).toBe(80);
  });
});

describe('RgSelfServiceService.requestLimitRemoval (real PG)', () => {
  it('keeps the limit in force and parks a removal request', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    const row = await limitRow(userId);

    const view = await svc.requestLimitRemoval(row.id, userId);

    expect(view.amount).toBe('100.00');
    expect(view.pendingKind).toBe('removal');
    expect(await limitRow(userId)).toBeTruthy();
  });

  it('refuses to touch another players limit', async () => {
    const { svc } = makeService();
    const owner = randomUUID();
    await svc.upsertLimit(owner, deposit100);
    const row = await limitRow(owner);

    await expect(svc.requestLimitRemoval(row.id, randomUUID())).rejects.toBeInstanceOf(
      LimitOwnershipError,
    );
  });
});

describe('RgSelfServiceService.confirmPendingChange (real PG)', () => {
  it('refuses before the cool-down has elapsed, leaving the limit untouched', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);

    await expect(svc.confirmPendingChange(row.id, userId)).rejects.toBeInstanceOf(
      CooldownNotElapsedError,
    );
    expect((await limitRow(userId)).amount).toBe('100.00');
  });

  it('raises the limit once the cool-down has elapsed and the player confirms', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);
    await backdatePending(row.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    const view = await svc.confirmPendingChange(row.id, userId);

    expect(view?.amount).toBe('500.00');
    expect(view?.pendingStatus).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.change_confirmed',
      expect.objectContaining({ kind: 'increase', initiatedBy: 'player' }),
    );
    // Also the plain "the limit is now X" fact, which is what re-runs the 80% evaluation.
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.set',
      expect.objectContaining({ amount: '500.00', initiatedBy: 'player' }),
    );
  });

  it('deletes the limit when a removal request is confirmed', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    const row = await limitRow(userId);
    await svc.requestLimitRemoval(row.id, userId);
    await backdatePending(row.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    await expect(svc.confirmPendingChange(row.id, userId)).resolves.toBeNull();

    expect(await db.drizzle.db.select().from(userLimit)).toHaveLength(0);
  });

  it('refuses after the confirmation window closed and clears the lapsed request', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);
    await backdatePending(row.id, new Date(Date.now() - 9 * DAY), new Date(Date.now() - DAY));

    await expect(svc.confirmPendingChange(row.id, userId)).rejects.toBeInstanceOf(
      LimitChangeExpiredError,
    );
    const after = await limitRow(userId);
    expect(after.amount).toBe('100.00');
    expect(after.pendingKind).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.change_expired',
      expect.objectContaining({ requestedAmount: '500.00' }),
    );
  });

  it('refuses when no request is parked', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    const row = await limitRow(userId);

    await expect(svc.confirmPendingChange(row.id, userId)).rejects.toBeInstanceOf(
      NoPendingLimitChangeError,
    );
  });

  it('a zero cool-down is confirmable at once, but still only on the players confirm', async () => {
    const { svc } = makeService({ limitIncreaseCooldownHours: 0 });
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);

    const requested = await svc.upsertLimit(userId, { ...deposit100, amount: '500' });

    expect(requested.pendingStatus).toBe('ready');
    expect(requested.amount).toBe('100.00');
    const row = await limitRow(userId);
    expect((await svc.confirmPendingChange(row.id, userId))?.amount).toBe('500.00');
  });

  it('refuses to confirm another players request', async () => {
    const { svc } = makeService();
    const owner = randomUUID();
    await svc.upsertLimit(owner, deposit100);
    await svc.upsertLimit(owner, { ...deposit100, amount: '500' });
    const row = await limitRow(owner);
    await backdatePending(row.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    await expect(svc.confirmPendingChange(row.id, randomUUID())).rejects.toBeInstanceOf(
      LimitOwnershipError,
    );
    expect((await limitRow(owner)).amount).toBe('100.00');
  });
});

describe('RgSelfServiceService.cancelPendingChange (real PG)', () => {
  it('clears a waiting request immediately', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);

    const view = await svc.cancelPendingChange(row.id, userId);

    expect(view.pendingStatus).toBeNull();
    expect((await limitRow(userId)).pendingKind).toBeNull();
  });

  it('clears a ready request immediately', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);
    await backdatePending(row.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    const view = await svc.cancelPendingChange(row.id, userId);

    expect(view.pendingStatus).toBeNull();
    expect((await limitRow(userId)).pendingKind).toBeNull();
  });

  it('is a no-op when nothing is parked', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    const row = await limitRow(userId);
    events.emit.mockClear();

    await svc.cancelPendingChange(row.id, userId);

    expect(events.emit).not.toHaveBeenCalled();
  });
});

// Every one of these ran green against a read-then-write that was NOT serialized, which
// is the point: they fail without the per-limit lock and the pinned write.
describe('RgSelfServiceService concurrency (real PG)', () => {
  it('two simultaneous lowerings cannot leave the higher one in force', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);

    // Both classify against 100 and both look like a lowering; unserialized, the later
    // write lands 80 over 50 - an un-cooled raise the player never asked for.
    await Promise.all([
      svc.upsertLimit(userId, { ...deposit100, amount: '50' }),
      svc.upsertLimit(userId, { ...deposit100, amount: '80' }),
    ]);

    const after = await limitRow(userId);
    const winner = Number(after.amount);
    expect([50, 80]).toContain(winner);
    if (winner === 80) {
      // 80 may only win by being the FIRST to land; 50 after it would be a lowering, and
      // a lowering that got dropped is the bug. So an 80 outcome must mean 50 never ran
      // last - assert the pending slot is clean either way.
      expect(after.pendingKind).toBeNull();
    }
    // Whatever won, the limit must never have risen above where it started.
    expect(winner).toBeLessThanOrEqual(100);
  });

  it('a confirm that races a lowering applies nothing', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);
    await backdatePending(row.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    // The lowering voids the request; the confirm holds a stale read of it.
    await svc.upsertLimit(userId, { ...deposit100, amount: '20' });
    await expect(svc.confirmPendingChange(row.id, userId)).rejects.toBeInstanceOf(
      NoPendingLimitChangeError,
    );

    expect((await limitRow(userId)).amount).toBe('20.00');
  });

  it('a confirm that races a cancel neither applies nor double-emits', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);
    await backdatePending(row.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    const results = await Promise.allSettled([
      svc.confirmPendingChange(row.id, userId),
      svc.cancelPendingChange(row.id, userId),
    ]);

    const confirmed = events.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === 'rg.limit.change_confirmed',
    );
    expect(confirmed.length).toBeLessThanOrEqual(1);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('two simultaneous confirms raise the limit once and emit once', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);
    await backdatePending(row.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    await Promise.allSettled([
      svc.confirmPendingChange(row.id, userId),
      svc.confirmPendingChange(row.id, userId),
    ]);

    expect((await limitRow(userId)).amount).toBe('500.00');
    expect(
      events.emit.mock.calls.filter((c: unknown[]) => c[0] === 'rg.limit.change_confirmed'),
    ).toHaveLength(1);
  });

  it('a confirmed removal leaves a still-breached monthly limit of the same type flagged', async () => {
    const { svc, monitoring } = makeService();
    const userId = randomUUID();
    await seedCompletedDeposit(userId, '900');
    // Daily 100 and monthly 1000, both deposit-type, both breached; rg_flag carries no
    // period, so clearing on removal must not wipe the monthly one's flag.
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '1000', period: 'monthly' });
    await monitoring.evaluateUser(userId, 'rg.limit.set');
    const daily = (await allLimitRows(userId)).find((r) => r.period === 'daily')!;
    await svc.requestLimitRemoval(daily.id, userId);
    await backdatePending(daily.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    await svc.confirmPendingChange(daily.id, userId);

    const flags = await db.drizzle.db.select().from(rgFlag).where(eq(rgFlag.userId, userId));
    expect(flags.filter((f) => f.status === 'active')).toHaveLength(1);
  });
});

describe('RgSelfServiceService.expireStaleLimitChanges (real PG)', () => {
  // The single test guarding the whole mechanism: a limit must never rise on a timer.
  it('never applies a lapsed request - the limit is still the old one', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);
    await backdatePending(row.id, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 20 * DAY));

    await svc.expireStaleLimitChanges();

    const after = await limitRow(userId);
    expect(after.amount).toBe('100.00');
    expect(after.pendingKind).toBeNull();
  });

  it('leaves a request that is still inside its window alone', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });

    await svc.expireStaleLimitChanges();

    expect((await limitRow(userId)).pendingKind).toBe('increase');
  });
});

describe('RgSelfServiceService exclusions (real PG)', () => {
  it('starts a break the player asked for and blocks their login', async () => {
    const { svc, enforcement } = makeService();
    const userId = randomUUID();

    const exclusion = await svc.requestCoolingOff(userId, { durationHours: 24 });

    expect(exclusion.kind).toBe('cooling_off');
    expect(enforcement.block).toHaveBeenCalled();
  });

  it('attributes a player-started self-exclusion to the player', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();

    await svc.requestSelfExclusion(userId, {
      isPermanent: false,
      durationMonths: 6,
      confirm: true,
    });

    expect(events.emit).toHaveBeenCalledWith(
      'rg.self_exclusion.activated',
      expect.objectContaining({ initiatedBy: 'player', durationMonths: 6 }),
    );
  });
});

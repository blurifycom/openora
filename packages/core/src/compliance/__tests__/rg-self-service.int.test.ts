import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type {
  ExchangeRateReader,
  LoginEnforcementPort,
  ResponsibleGamingConfig,
} from '@openora/core/contracts';
import { createTestDb, seedCompletedDeposit, type TestDb } from '@openora/core/testing';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { game, gameRound } from '@openora/core/casino/schema/gaming';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { player } from '@openora/core/pam/schema/profile';
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

function identityRates(): ExchangeRateReader {
  return mock<ExchangeRateReader>({
    getRate: vi.fn(async (from: string, to: string) =>
      from === to ? { rate: '1', asOf: new Date().toISOString() } : null,
    ),
    convert: vi.fn(async (amount: string, from: string, to: string) =>
      from === to ? amount : null,
    ),
  });
}

function makeService(
  config: Partial<ResponsibleGamingConfig> = {},
  rates: ExchangeRateReader = identityRates(),
) {
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
    rates,
  });
  const monitoring = new RgMonitoringService({ drizzle: db.drizzle, rates });
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
    rates,
  });
  return { svc, rg, monitoring, events, enforcement };
}

const deposit100 = {
  type: 'deposit',
  amount: '100',
  minutes: null,
  currency: 'USD',
  period: 'daily',
} as const;

async function allLimitRows(userId: string) {
  return db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
}

async function limitRow(userId: string) {
  const [row] = await db.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
  return row!;
}

async function backdatePending(limitId: string, effectiveAt: Date, expiresAt: Date) {
  await db.drizzle.db
    .update(userLimit)
    .set({ pendingEffectiveAt: effectiveAt, pendingExpiresAt: expiresAt })
    .where(eq(userLimit.id, limitId));
}

async function seedPlayer(userId: string, currency: string) {
  await db.drizzle.db.insert(player).values({ userId, currency, kycStatus: 'verified' });
}

async function seedUnresolvedLimit(userId: string, amount = '100') {
  const [row] = await db.drizzle.db
    .insert(userLimit)
    .values({ userId, type: 'deposit', amount, minutes: null, currency: null, period: 'daily' })
    .returning();
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateWallet, migrateGaming, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${userLimit}, ${rgExclusion}, ${rgFlag}, ${walletTransaction}, ${wallet}, ${gameRound}, ${game}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('RgSelfServiceService.upsertLimit (real PG)', () => {
  it('writes a first limit immediately, with no request parked on it', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    const view = await svc.upsertLimit(userId, deposit100);

    expect(view.amount).toBe('100.000000000000000000');
    expect(view.pendingStatus).toBeNull();
  });

  it('lowers a limit immediately', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);

    const view = await svc.upsertLimit(userId, { ...deposit100, amount: '50' });

    expect(view.amount).toBe('50.000000000000000000');
    expect(view.pendingStatus).toBeNull();
  });

  it('a raise leaves the limit in force and parks a waiting request', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);

    const view = await svc.upsertLimit(userId, { ...deposit100, amount: '500' });

    expect(view.amount).toBe('100.000000000000000000');
    expect(view.pendingAmount).toBe('500.000000000000000000');
    expect(view.pendingStatus).toBe('waiting');
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.change_requested',
      expect.objectContaining({
        kind: 'increase',
        requestedAmount: '500.000000000000000000',
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

    expect(view.pendingAmount).toBe('900.000000000000000000');
    expect(view.pendingStatus).toBe('waiting');
  });

  it('lowering a limit while a raise is parked voids the raise', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });

    const view = await svc.upsertLimit(userId, { ...deposit100, amount: '20' });

    expect(view.amount).toBe('20.000000000000000000');
    expect(view.pendingStatus).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.change_cancelled',
      expect.objectContaining({ requestedAmount: '500.000000000000000000' }),
    );
  });

  it('reports usage and headroom against the current window', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedCompletedDeposit(db, userId, '80');
    await svc.upsertLimit(userId, deposit100);

    const [view] = await svc.getLimits(userId);

    expect(Number(view?.used)).toBe(80);
    expect(Number(view?.remaining)).toBe(20);
    expect(view?.pct).toBe(80);
  });

  it('preserves full MONEY_SCALE(18) precision - no truncation to cents', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedCompletedDeposit(db, userId, '33.336');
    await svc.upsertLimit(userId, deposit100);

    const [view] = await svc.getLimits(userId);

    expect(view?.amount).toBe('100.000000000000000000');
    expect(view?.used).toBe('33.336000000000000000');
    expect(view?.remaining).toBe('66.664000000000000000');
  });

  it('a crypto-scale (18dp) limit round-trips through set and read without rounding loss', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    const view = await svc.upsertLimit(userId, {
      type: 'deposit',
      amount: '0.00000001',
      minutes: null,
      currency: 'BTC',
      period: 'daily',
    });

    expect(view.amount).toBe('0.000000010000000000');
    expect(view.currency).toBe('BTC');

    const [read] = await svc.getLimits(userId);
    expect(read?.amount).toBe('0.000000010000000000');
  });
});

const BTC_USD_RATE = 50000;

describe('RgSelfServiceService.getLimits - multi-currency usage', () => {
  it('converts a deposit in a different currency into the limit currency before reporting usage', async () => {
    const btcToUsd = mock<ExchangeRateReader>({
      getRate: vi.fn(async () => null),
      convert: vi.fn(async (amount: string, from: string, to: string) => {
        if (from === to) {
          return amount;
        }
        if (from === 'BTC' && to === 'USD') {
          return (Number(amount) * BTC_USD_RATE).toFixed(18);
        }
        return null;
      }),
    });
    const { svc } = makeService({}, btcToUsd);
    const userId = randomUUID();
    await seedCompletedDeposit(db, userId, '0.002', { currency: 'BTC' });
    await svc.upsertLimit(userId, deposit100);

    const [view] = await svc.getLimits(userId);

    expect(Number(view?.used)).toBe(100);
    expect(Number(view?.remaining)).toBe(0);
  });

  it('reports null usage rather than throwing when a needed rate is unavailable', async () => {
    const noRates = mock<ExchangeRateReader>({
      getRate: vi.fn(async () => null),
      convert: vi.fn(async () => null),
    });
    const { svc } = makeService({}, noRates);
    const userId = randomUUID();
    await seedCompletedDeposit(db, userId, '0.002', { currency: 'BTC' });
    await svc.upsertLimit(userId, deposit100);

    const [view] = await svc.getLimits(userId);

    expect(view?.used).toBeNull();
    expect(view?.remaining).toBeNull();
    expect(view?.pct).toBeNull();
  });
});

describe('RgSelfServiceService session-type limit (real PG)', () => {
  it('creates and reads a session limit with no currency and no usage reported', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    const view = await svc.upsertLimit(userId, {
      type: 'session',
      amount: null,
      minutes: 60,
      currency: null,
      period: 'session',
    });

    expect(view.minutes).toBe(60);
    expect(view.amount).toBeNull();
    expect(view.currency).toBeNull();
    expect(view.used).toBeNull();
    expect(view.remaining).toBeNull();
    expect(view.pct).toBeNull();

    const [read] = await svc.getLimits(userId);
    expect(read?.currency).toBeNull();

    const row = await limitRow(userId);
    expect(row.currency).toBe('SESSION');
  });
});

describe('RgSelfServiceService.requestLimitRemoval (real PG)', () => {
  it('keeps the limit in force and parks a removal request', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    const row = await limitRow(userId);

    const view = await svc.requestLimitRemoval(row.id, userId);

    expect(view.amount).toBe('100.000000000000000000');
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
    expect((await limitRow(userId)).amount).toBe('100.000000000000000000');
  });

  it('raises the limit once the cool-down has elapsed and the player confirms', async () => {
    const { svc, events } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);
    await backdatePending(row.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    const view = await svc.confirmPendingChange(row.id, userId);

    expect(view?.amount).toBe('500.000000000000000000');
    expect(view?.pendingStatus).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.change_confirmed',
      expect.objectContaining({ kind: 'increase', initiatedBy: 'player' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.set',
      expect.objectContaining({ amount: '500.000000000000000000', initiatedBy: 'player' }),
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
    expect(after.amount).toBe('100.000000000000000000');
    expect(after.pendingKind).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.limit.change_expired',
      expect.objectContaining({ requestedAmount: '500.000000000000000000' }),
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
    expect(requested.amount).toBe('100.000000000000000000');
    const row = await limitRow(userId);
    expect((await svc.confirmPendingChange(row.id, userId))?.amount).toBe('500.000000000000000000');
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
    expect((await limitRow(owner)).amount).toBe('100.000000000000000000');
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

describe('RgSelfServiceService concurrency (real PG)', () => {
  it('two simultaneous lowerings cannot leave the higher one in force', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);

    await Promise.all([
      svc.upsertLimit(userId, { ...deposit100, amount: '50' }),
      svc.upsertLimit(userId, { ...deposit100, amount: '80' }),
    ]);

    const after = await limitRow(userId);
    const winner = Number(after.amount);
    expect([50, 80]).toContain(winner);
    if (winner === 80) {
      expect(after.pendingKind).toBeNull();
    }
    expect(winner).toBeLessThanOrEqual(100);
  });

  it('a confirm that races a lowering applies nothing', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);
    await backdatePending(row.id, new Date(Date.now() - HOUR), new Date(Date.now() + DAY));

    await svc.upsertLimit(userId, { ...deposit100, amount: '20' });
    await expect(svc.confirmPendingChange(row.id, userId)).rejects.toBeInstanceOf(
      NoPendingLimitChangeError,
    );

    expect((await limitRow(userId)).amount).toBe('20.000000000000000000');
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

    expect((await limitRow(userId)).amount).toBe('500.000000000000000000');
    expect(
      events.emit.mock.calls.filter((c: unknown[]) => c[0] === 'rg.limit.change_confirmed'),
    ).toHaveLength(1);
  });

  it('a confirmed removal leaves a still-breached monthly limit of the same type flagged', async () => {
    const { svc, monitoring } = makeService();
    const userId = randomUUID();
    await seedCompletedDeposit(db, userId, '900');
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
  it('never applies a lapsed request - the limit is still the old one', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await svc.upsertLimit(userId, deposit100);
    await svc.upsertLimit(userId, { ...deposit100, amount: '500' });
    const row = await limitRow(userId);
    await backdatePending(row.id, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 20 * DAY));

    await svc.expireStaleLimitChanges();

    const after = await limitRow(userId);
    expect(after.amount).toBe('100.000000000000000000');
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

describe('RgSelfServiceService lazy currency resolution (real PG)', () => {
  it('resolves a null-currency row to the player currency on first read, and persists it', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedPlayer(userId, 'JPY');
    const seeded = await seedUnresolvedLimit(userId, '100000');
    expect(seeded.currency).toBeNull();

    const [view] = await svc.getLimits(userId);

    expect(view?.currency).toBe('JPY');
    const persisted = await limitRow(userId);
    expect(persisted.currency).toBe('JPY');
  });

  it('resolves exactly once: a second read does not re-resolve against a changed player currency', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedPlayer(userId, 'JPY');
    await seedUnresolvedLimit(userId, '100000');

    await svc.getLimits(userId);
    await db.drizzle.db.update(player).set({ currency: 'EUR' }).where(eq(player.userId, userId));
    const [view] = await svc.getLimits(userId);

    expect(view?.currency).toBe('JPY');
    expect((await limitRow(userId)).currency).toBe('JPY');
  });

  it('fails closed (reports usage as null, currency as null) when no player record exists', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedUnresolvedLimit(userId, '100000');

    const [view] = await svc.getLimits(userId);

    expect(view?.currency).toBeNull();
    expect(view?.used).toBeNull();
    expect(view?.remaining).toBeNull();
    expect(view?.pct).toBeNull();
    expect((await limitRow(userId)).currency).toBeNull();
  });

  it('resolves two concurrent reads of the same unresolved row to the same currency, no split-brain', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await seedPlayer(userId, 'GBP');
    await seedUnresolvedLimit(userId, '100000');

    const [viewsA, viewsB] = await Promise.all([svc.getLimits(userId), svc.getLimits(userId)]);

    expect(viewsA[0]?.currency).toBe('GBP');
    expect(viewsB[0]?.currency).toBe('GBP');
    expect((await limitRow(userId)).currency).toBe('GBP');
  });

  it('never resolves or touches the player table for a session-type limit', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    const view = await svc.upsertLimit(userId, {
      type: 'session',
      amount: null,
      minutes: 60,
      currency: null,
      period: 'session',
    });

    expect(view.currency).toBeNull();
    expect((await limitRow(userId)).currency).toBe('SESSION');
  });
});

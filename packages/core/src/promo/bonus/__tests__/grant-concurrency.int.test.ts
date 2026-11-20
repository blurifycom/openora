import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type {
  BonusGrantArgs,
  GrantConcurrencyMode,
  PlayEligibilityPort,
  Uuid,
  WagerProduct,
} from '@openora/core/contracts';
import { makeAuditWriter, makeEventBus, mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  promoGrant,
  promoGrantEntry,
  promoGrantRound,
  promoWeight,
  promoWeightProfile,
} from '../schema/index.js';
import {
  GrantActivationRestrictedError,
  GrantLifecycleService,
  GrantNotActivatableError,
  GrantNotFoundError,
} from '../service/grant-lifecycle.service.js';
import { GrantService } from '../service/grant.service.js';
import { WageringService } from '../service/wagering.service.js';
import { BonusSlotTakenError } from '../shared/grant-slot.js';

let db: TestDb;
let audit: ReturnType<typeof makeAuditWriter>;
let events: ReturnType<typeof makeEventBus>;

const DAY_MS = 86_400_000;

const profileAt = async (contributionPercent: string): Promise<Uuid> => {
  const { id } = findOneOrThrow(
    await db.drizzle.db
      .insert(promoWeightProfile)
      .values({ name: `profile-${randomUUID()}` })
      .returning(),
    new Error('seed profile: query returned no row'),
  );
  await db.drizzle.db
    .insert(promoWeight)
    .values({ profileId: id, scope: 'default', scopeRef: null, contributionPercent });
  return id;
};

type GrantOptions = {
  userId: Uuid;
  mode?: GrantConcurrencyMode;
  currency?: string;
  source?: BonusGrantArgs['source'];
  amount?: string;
  multiplier?: string;
  expiryDays?: number;
  percent?: string;
  maxBet?: string;
  excludedProducts?: WagerProduct[];
  onSlotTaken?: BonusGrantArgs['onSlotTaken'];
};

const grantWith = async (o: GrantOptions) => {
  const source = o.source ?? 'deposit';
  const weightProfileId = await profileAt(o.percent ?? '100');
  return db.drizzle.db.transaction((tx) =>
    new GrantService(audit, o.mode ?? 'multiple').grant(tx, {
      userId: o.userId,
      currency: o.currency ?? 'USD',
      amount: o.amount ?? '10',
      source,
      sourceRef: randomUUID(),
      actor: source === 'manual' ? { type: 'admin', id: randomUUID() } : { type: 'system' },
      terms: {
        wageringMultiplier: o.multiplier ?? '3',
        expiryDays: o.expiryDays ?? 30,
        weightProfileId,
        ...(o.maxBet ? { maxBet: o.maxBet } : {}),
        ...(o.excludedProducts ? { excludedProducts: o.excludedProducts } : {}),
      },
      ...(o.onSlotTaken ? { onSlotTaken: o.onSlotTaken } : {}),
    }),
  );
};

const grantIdOf = async (o: GrantOptions) => {
  const outcome = await grantWith(o);
  if (!outcome.ok) {
    throw new Error(`grant was refused: ${outcome.reason}`);
  }
  return outcome.grantId;
};

const rowOf = async (id: string) =>
  findOneOrThrow(
    await db.drizzle.db.select().from(promoGrant).where(eq(promoGrant.id, id)),
    new Error('rowOf: query returned no row'),
  );

const stakesOf = (id: string) =>
  db.drizzle.db
    .select()
    .from(promoGrantEntry)
    .where(sql`${promoGrantEntry.grantId} = ${id} and ${promoGrantEntry.type} = 'stake'`);

const lifecycle = (mode: GrantConcurrencyMode = 'single', restricted = false) =>
  new GrantLifecycleService(
    db.drizzle,
    audit,
    events,
    mock<PlayEligibilityPort>({ isRestricted: vi.fn(async () => restricted) }),
    mode,
  );

const wipeLedger = async () => {
  await db.drizzle.db.execute(
    sql`ALTER TABLE promo_grant_entry DISABLE TRIGGER promo_grant_entry_append_only, DISABLE TRIGGER promo_grant_entry_balance_matches_ledger`,
  );
  try {
    await db.drizzle.db.delete(promoGrantEntry);
  } finally {
    await db.drizzle.db.execute(
      sql`ALTER TABLE promo_grant_entry ENABLE TRIGGER promo_grant_entry_append_only, ENABLE TRIGGER promo_grant_entry_balance_matches_ledger`,
    );
  }
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
  audit = makeAuditWriter();
  events = makeEventBus();
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await wipeLedger();
  await db.drizzle.db.delete(promoGrantRound);
  await db.drizzle.db.delete(promoGrant);
  await db.drizzle.db.delete(promoWeight);
  await db.drizzle.db.delete(promoWeightProfile);
  vi.clearAllMocks();
});

describe('grant concurrency', () => {
  it('single: a second grant in the same currency waits as pending, whatever its source', async () => {
    const userId = randomUUID();
    await grantIdOf({ userId, mode: 'single' });

    const second = await grantWith({ userId, mode: 'single', source: 'manual' });

    expect(second).toMatchObject({ ok: true, status: 'pending' });
    const row = await rowOf(second.ok ? second.grantId : '');
    expect(row).toMatchObject({ status: 'pending', activatedAt: null });
  });

  it('single: a grant in another currency takes its own slot', async () => {
    const userId = randomUUID();
    await grantIdOf({ userId, mode: 'single' });

    const other = await grantWith({ userId, mode: 'single', currency: 'EUR' });

    expect(other).toMatchObject({ ok: true, status: 'active' });
  });

  it('per_source: one active grant per source', async () => {
    const userId = randomUUID();
    await grantIdOf({ userId, mode: 'per_source' });

    const sameSource = await grantWith({ userId, mode: 'per_source' });
    const otherSource = await grantWith({ userId, mode: 'per_source', source: 'manual' });

    expect(sameSource).toMatchObject({ ok: true, status: 'pending' });
    expect(otherSource).toMatchObject({ ok: true, status: 'active' });
  });

  it('multiple: every grant is active at once', async () => {
    const userId = randomUUID();
    await grantIdOf({ userId, mode: 'multiple' });

    const second = await grantWith({ userId, mode: 'multiple' });

    expect(second).toMatchObject({ ok: true, status: 'active' });
  });

  it('a pending grant does not take the slot for the next one', async () => {
    const userId = randomUUID();
    await grantIdOf({ userId, mode: 'single' });
    await grantIdOf({ userId, mode: 'single' });

    const third = await grantWith({ userId, mode: 'single' });

    expect(third).toMatchObject({ ok: true, status: 'pending' });
  });

  it('refuses instead of queueing when the caller asks it to, and writes nothing', async () => {
    const userId = randomUUID();
    await grantIdOf({ userId, mode: 'single' });

    const refused = await grantWith({ userId, mode: 'single', onSlotTaken: 'refuse' });

    expect(refused).toEqual({ ok: false, reason: 'slot_taken' });
    expect(
      await db.drizzle.db.select().from(promoGrant).where(eq(promoGrant.userId, userId)),
    ).toHaveLength(1);
  });

  it('replays a grant by its source reference rather than refusing it as slot-taken', async () => {
    const userId = randomUUID();
    const weightProfileId = await profileAt('100');
    const args: BonusGrantArgs = {
      userId,
      currency: 'USD',
      amount: '10',
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      terms: { wageringMultiplier: '3', expiryDays: 30, weightProfileId },
      onSlotTaken: 'refuse',
    };
    const service = new GrantService(audit, 'single');
    const first = await db.drizzle.db.transaction((tx) => service.grant(tx, args));

    const replay = await db.drizzle.db.transaction((tx) => service.grant(tx, args));

    expect(replay).toMatchObject({ ok: true, created: false, status: 'active' });
    expect(first).toMatchObject({ ok: true });
  });
});

describe('activating a pending grant', () => {
  const pendingBehindActive = async () => {
    const userId = randomUUID();
    const active = await grantIdOf({ userId, mode: 'single' });
    const pending = await grantIdOf({ userId, mode: 'single', expiryDays: 7 });
    return { userId, active, pending };
  };

  it('activates once the slot is free and restarts the rollover window from now', async () => {
    const { userId, active, pending } = await pendingBehindActive();
    // Most of the claim window has gone by.
    await db.drizzle.db
      .update(promoGrant)
      .set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(promoGrant.id, pending));
    await lifecycle().forfeit({ grantId: active, reason: 'player_opt_out', note: 'test' });

    const before = Date.now();
    const activated = await lifecycle().activate({ userId, grantId: pending });

    const row = await rowOf(pending);
    expect(row.status).toBe('active');
    expect(row.activatedAt).not.toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY_MS - 60_000);
    expect(activated).toMatchObject({ id: pending, status: 'active' });
    expect(events.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'promo.bonus.activated',
      expect.objectContaining({ userId, grantId: pending, currency: 'USD', source: 'deposit' }),
    );
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'promo.bonus.activated',
        actorType: 'player',
        resourceId: pending,
      }),
    );
  });

  it('refuses while another grant still holds the slot', async () => {
    const { userId, pending } = await pendingBehindActive();

    await expect(lifecycle().activate({ userId, grantId: pending })).rejects.toBeInstanceOf(
      BonusSlotTakenError,
    );
    expect((await rowOf(pending)).status).toBe('pending');
  });

  it('refuses a player who may no longer play, leaving the grant pending', async () => {
    const { userId, active, pending } = await pendingBehindActive();
    await lifecycle().forfeit({ grantId: active, reason: 'player_opt_out', note: 'test' });

    await expect(
      lifecycle('single', true).activate({ userId, grantId: pending }),
    ).rejects.toBeInstanceOf(GrantActivationRestrictedError);
    const row = await rowOf(pending);
    expect(row.status).toBe('pending');
    expect(row.activatedAt).toBeNull();
  });

  it('refuses a grant that is not pending', async () => {
    const { userId, active } = await pendingBehindActive();

    await expect(lifecycle().activate({ userId, grantId: active })).rejects.toBeInstanceOf(
      GrantNotActivatableError,
    );
  });

  it('refuses a pending grant whose claim window has passed', async () => {
    const { userId, active, pending } = await pendingBehindActive();
    await lifecycle().forfeit({ grantId: active, reason: 'player_opt_out', note: 'test' });
    await db.drizzle.db
      .update(promoGrant)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(promoGrant.id, pending));

    await expect(lifecycle().activate({ userId, grantId: pending })).rejects.toBeInstanceOf(
      GrantNotActivatableError,
    );
  });

  it("answers not-found for another player's grant", async () => {
    const { pending } = await pendingBehindActive();

    await expect(
      lifecycle().activate({ userId: randomUUID(), grantId: pending }),
    ).rejects.toBeInstanceOf(GrantNotFoundError);
  });

  it('expires a pending grant left past its claim window', async () => {
    const { pending } = await pendingBehindActive();
    await db.drizzle.db
      .update(promoGrant)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(promoGrant.id, pending));

    const closed = await lifecycle().expireDue();

    expect(closed.map((c) => c.grantId)).toContain(pending);
    expect(await rowOf(pending)).toMatchObject({
      status: 'expired',
      bonusBalance: '0.000000000000000000',
      activatedAt: null,
    });
  });
});

describe('wagering across several active grants', () => {
  // `realAvailable` is the player's real balance; whatever it cannot cover comes from bonus funds.
  const bet = async (
    userId: string,
    stake: string,
    realAvailable = stake,
    product: WagerProduct = 'casino',
  ) => {
    const round = { providerName: 'aggregator', externalRoundId: randomUUID() };
    const wagering = new WageringService(audit);
    const outcome = await db.drizzle.db.transaction((tx) =>
      wagering.wager(tx, {
        userId,
        currency: 'USD',
        stake,
        realAvailable,
        context: { provider: 'aggregator', product },
        ...round,
      }),
    );
    // A grant completes when the round settles: here as a loss.
    const closed = outcome.ok
      ? await db.drizzle.db.transaction((tx) =>
          wagering.closeRound(tx, { userId, currency: 'USD', realBalance: '0', ...round }),
        )
      : { completed: [] };
    return { outcome, completed: closed.completed };
  };

  it('fills rollovers earliest expiry first, carrying the remainder weighted by the next grant', async () => {
    const userId = randomUUID();
    // Created out of rollover order on purpose; each needs 30 of weighted stake.
    const last = await grantIdOf({ userId, expiryDays: 30 });
    const first = await grantIdOf({ userId, expiryDays: 10 });
    const middle = await grantIdOf({ userId, expiryDays: 20, percent: '50' });

    const { outcome, completed } = await bet(userId, '100');

    expect(outcome).toMatchObject({ ok: true, grantId: first, bonusSpent: '0' });
    // 30 fills the first; 60 at 50% fills the middle; 10 is left for the last.
    expect(Number((await rowOf(first)).wageringProgress)).toBe(30);
    expect(Number((await rowOf(middle)).wageringProgress)).toBe(30);
    expect(Number((await rowOf(last)).wageringProgress)).toBe(10);
    expect((await rowOf(first)).status).toBe('completed');
    expect((await rowOf(middle)).status).toBe('completed');
    expect((await rowOf(last)).status).toBe('active');
    expect(completed.map((c) => c.grantId).sort()).toEqual([first, middle].sort());
    expect(completed.map((c) => Number(c.convertedAmount))).toEqual([10, 10]);
    expect(outcome.ok && Number(outcome.bonusBalanceAfter)).toBe(30);
    // Each part at its own grant's weight: 30 + 60 x 50% + 10.
    expect(outcome.ok && Number(outcome.weightedAmount)).toBe(70);

    const realOf = async (id: string) =>
      (await stakesOf(id)).reduce((sum, e) => sum + Number(e.realAmount), 0);
    expect(await realOf(first)).toBe(30);
    expect(await realOf(middle)).toBe(60);
    expect(await realOf(last)).toBe(10);
  });

  it("reports the weighted stake at the weight of each grant it landed on, not the first one's", async () => {
    const userId = randomUUID();
    await grantIdOf({ userId, expiryDays: 10, percent: '50', multiplier: '1' });
    const second = await grantIdOf({ userId, expiryDays: 20 });

    const { outcome } = await bet(userId, '40');

    // 20 at 50% fills the first; the other 20 counts in full on the second.
    expect(outcome.ok && Number(outcome.weightedAmount)).toBe(30);
    expect(Number((await rowOf(second)).wageringProgress)).toBe(20);
  });

  it('never counts the same stake on two grants', async () => {
    const userId = randomUUID();
    const a = await grantIdOf({ userId, expiryDays: 10 });
    const b = await grantIdOf({ userId, expiryDays: 20 });

    await bet(userId, '20');

    expect(Number((await rowOf(a)).wageringProgress)).toBe(20);
    expect(Number((await rowOf(b)).wageringProgress)).toBe(0);
  });

  it('counts bonus-funded stake only on the grant whose funds paid it', async () => {
    const userId = randomUUID();
    // The earliest grant cannot pay a casino bet, so the second one funds it.
    const excluded = await grantIdOf({ userId, expiryDays: 10, excludedProducts: ['casino'] });
    const funding = await grantIdOf({ userId, expiryDays: 20 });

    const { outcome } = await bet(userId, '6', '0');

    expect(outcome).toMatchObject({ ok: true, bonusSpent: '6' });
    expect(await rowOf(excluded)).toMatchObject({
      wageringProgress: '0.000000000000000000',
      bonusBalance: '10.000000000000000000',
    });
    const funded = await rowOf(funding);
    expect(Number(funded.wageringProgress)).toBe(6);
    expect(Number(funded.bonusBalance)).toBe(4);
  });

  it('spreads a bonus stake bigger than one grant across the next, earliest first', async () => {
    const userId = randomUUID();
    const a = await grantIdOf({ userId, expiryDays: 10 });
    const b = await grantIdOf({ userId, expiryDays: 20 });

    const { outcome } = await bet(userId, '15', '0');

    expect(outcome.ok && Number(outcome.bonusSpent)).toBe(15);
    expect(Number((await rowOf(a)).bonusBalance)).toBe(0);
    expect(Number((await rowOf(a)).wageringProgress)).toBe(10);
    expect(Number((await rowOf(b)).bonusBalance)).toBe(5);
    expect(Number((await rowOf(b)).wageringProgress)).toBe(5);
  });

  it('refuses a bonus stake the grants that may pay it cannot cover, naming what they hold', async () => {
    const userId = randomUUID();
    await grantIdOf({ userId, expiryDays: 10 });
    await grantIdOf({ userId, expiryDays: 20, excludedProducts: ['casino'] });

    const { outcome } = await bet(userId, '15', '0');

    expect(outcome).toMatchObject({ ok: false, reason: 'insufficient_bonus' });
    expect(
      Number(!outcome.ok && outcome.reason === 'insufficient_bonus' && outcome.bonusAvailable),
    ).toBe(10);
  });

  it('holds the stake to the strictest max bet among the active grants', async () => {
    const userId = randomUUID();
    await grantIdOf({ userId, expiryDays: 10, maxBet: '50' });
    await grantIdOf({ userId, expiryDays: 20, maxBet: '5' });

    const { outcome } = await bet(userId, '10');

    expect(outcome).toMatchObject({ ok: false, reason: 'max_bet_exceeded', maxBet: '5' });
  });

  it('leaves a pending grant out of wagering entirely', async () => {
    const userId = randomUUID();
    const active = await grantIdOf({ userId, mode: 'single', expiryDays: 20 });
    const pending = await grantIdOf({ userId, mode: 'single', expiryDays: 5 });

    await bet(userId, '50');

    expect(Number((await rowOf(active)).wageringProgress)).toBe(30);
    expect(await rowOf(pending)).toMatchObject({
      status: 'pending',
      wageringProgress: '0.000000000000000000',
    });
  });

  it('returns a win on a bet split across grants to the balances that paid it', async () => {
    const userId = randomUUID();
    const a = await grantIdOf({ userId, expiryDays: 10, amount: '100', multiplier: '10' });
    const b = await grantIdOf({ userId, expiryDays: 20, amount: '100', multiplier: '10' });
    const round = { providerName: 'aggregator', externalRoundId: randomUUID() };
    const wagering = new WageringService(audit);
    await db.drizzle.db.transaction((tx) =>
      wagering.wager(tx, {
        userId,
        currency: 'USD',
        stake: '150',
        realAvailable: '0',
        context: { provider: 'aggregator', product: 'casino' },
        ...round,
      }),
    );

    const settled = await db.drizzle.db.transaction((tx) =>
      wagering.settle(tx, {
        userId,
        currency: 'USD',
        amount: '300',
        kind: 'win',
        realBalance: '0',
        ...round,
      }),
    );

    expect(Number(settled.bonusShare)).toBe(300);
    expect(Number((await rowOf(a)).bonusBalance)).toBe(200);
    expect(Number((await rowOf(b)).bonusBalance)).toBe(150);
  });
});

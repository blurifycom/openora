import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type {
  AuditWritePort,
  BonusGrantArgs,
  BonusWagerArgs,
  PlayEligibilityPort,
  WagerContext,
  WalletReader,
} from '@openora/core/contracts';
import { moneyAdd, type EventBus } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { seedDefaultWeightProfile } from '../seed/index.js';
import {
  promoGrant,
  promoGrantEntry,
  promoOffer,
  promoOptIn,
  promoOptInDeposit,
  promoWeight,
  promoWeightProfile,
} from '../schema/index.js';
import { GrantLifecycleService } from '../service/grant-lifecycle.service.js';
import { GrantService } from '../service/grant.service.js';
import { OfferService } from '../service/offer.service.js';
import { WageringService } from '../service/wagering.service.js';

type RecordedAudit = Parameters<AuditWritePort['record']>[0];
type RecordedEvent = { event: string; payload: unknown };

const CURRENCY = 'USD';
const PROVIDER = 'test-provider';

let db: TestDb;
let audit: RecordedAudit[];
let events: RecordedEvent[];
let grants: GrantService;
let wagering: WageringService;
let lifecycle: GrantLifecycleService;
let offers: OfferService;

const unused = async (): Promise<never> => {
  throw new Error('not used by the bonus engine under test');
};

const walletReader: WalletReader = {
  getLifetimeDeposit: async () => '0',
  isFirstDeposit: async () => true,
  getBalances: unused,
  getWithdrawalCountInWindow: unused,
  getDepositsByCurrency: unused,
  getMoneyByWindow: unused,
  hasWallet: unused,
  sumProviderTransactions: unused,
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
  await seedDefaultWeightProfile(db.drizzle.db);
  audit = [];
  events = [];
  const auditPort: AuditWritePort = {
    record: async (entry) => {
      audit.push(entry);
    },
    recordInTransaction: async (_tx, entry) => {
      audit.push(entry);
    },
    recordManyInTransaction: async (_tx, entries) => {
      audit.push(...entries);
    },
  };
  const eventBus: EventBus = {
    emit: (event, payload) => {
      events.push({ event, payload });
    },
    emitRaw: (event, payload) => {
      events.push({ event, payload });
    },
    emitInTransaction: async (_tx, event, payload) => {
      events.push({ event, payload });
    },
    on: () => () => undefined,
    tapTransactional: () => undefined,
  };
  const eligibility: PlayEligibilityPort = { isRestricted: async () => false };
  grants = new GrantService(auditPort);
  wagering = new WageringService();
  lifecycle = new GrantLifecycleService(db.drizzle, auditPort, eventBus, eligibility);
  offers = new OfferService(db.drizzle, auditPort, grants, walletReader, eligibility, {
    error: () => undefined,
  });
}, 120_000);

afterAll(() => db.drop());

const money = (value: string) => moneyAdd(value, '0');

const casino = (gameId = 'game-1'): WagerContext => ({
  provider: PROVIDER,
  product: 'casino',
  gameId,
});

async function newWeightProfile(
  rows: {
    scope: 'game' | 'category' | 'product' | 'default';
    ref: string | null;
    percent: string;
  }[],
): Promise<string> {
  const [profile] = await db.drizzle.db
    .insert(promoWeightProfile)
    .values({ name: `profile-${randomUUID()}` })
    .returning({ id: promoWeightProfile.id });
  if (!profile) {
    throw new Error('weight profile insert returned no row');
  }
  await db.drizzle.db.insert(promoWeight).values(
    rows.map((r) => ({
      profileId: profile.id,
      scope: r.scope,
      scopeRef: r.ref,
      contributionPercent: r.percent,
    })),
  );
  return profile.id;
}

type GrantOptions = {
  userId?: string;
  amount?: string;
  multiplier?: string;
  expiryDays?: number;
  weightProfileId?: string;
  maxBet?: string;
};

async function newGrant(options: GrantOptions = {}) {
  const userId = options.userId ?? randomUUID();
  const args: BonusGrantArgs = {
    userId,
    currency: CURRENCY,
    amount: options.amount ?? '100',
    source: 'deposit',
    sourceRef: randomUUID(),
    actor: { type: 'system' },
    terms: {
      wageringMultiplier: options.multiplier ?? '10',
      expiryDays: options.expiryDays ?? 30,
      ...(options.weightProfileId === undefined
        ? {}
        : { weightProfileId: options.weightProfileId }),
      ...(options.maxBet === undefined ? {} : { maxBet: options.maxBet }),
    },
  };
  const outcome = await db.drizzle.db.transaction((tx) => grants.grant(tx, args));
  if (!outcome.ok) {
    throw new Error(`grant refused: ${outcome.reason}`);
  }
  return { userId, grantId: outcome.grantId };
}

const wager = (
  userId: string,
  overrides: Partial<BonusWagerArgs> & Pick<BonusWagerArgs, 'stake'>,
) =>
  db.drizzle.db.transaction((tx) =>
    wagering.wager(tx, {
      userId,
      currency: CURRENCY,
      fromBonus: '0',
      context: casino(),
      providerName: PROVIDER,
      externalRoundId: randomUUID(),
      ...overrides,
    }),
  );

const settle = (
  userId: string,
  kind: 'win' | 'bet_reversal',
  amount: string,
  externalRoundId: string,
) =>
  db.drizzle.db.transaction((tx) =>
    wagering.settle(tx, {
      userId,
      currency: CURRENCY,
      amount,
      providerName: PROVIDER,
      externalRoundId,
      kind,
    }),
  );

async function grantRow(grantId: string) {
  const [row] = await db.drizzle.db.select().from(promoGrant).where(eq(promoGrant.id, grantId));
  if (!row) {
    throw new Error(`grant ${grantId} not found`);
  }
  return row;
}

const entriesOf = (grantId: string) =>
  db.drizzle.db.select().from(promoGrantEntry).where(eq(promoGrantEntry.grantId, grantId));

const entryTypes = async (grantId: string) =>
  (await entriesOf(grantId)).map((entry) => entry.type).sort();

const auditFor = (action: string, resourceId: string) =>
  audit.filter((entry) => entry.action === action && entry.resourceId === resourceId);

const eventsFor = (name: string, grantId: string) =>
  events.filter(
    (e) =>
      e.event === name &&
      typeof e.payload === 'object' &&
      e.payload !== null &&
      'grantId' in e.payload &&
      e.payload.grantId === grantId,
  );

const makeDue = (grantId: string) =>
  db.drizzle.db
    .update(promoGrant)
    .set({ expiresAt: sql`now() - interval '1 hour'` })
    .where(eq(promoGrant.id, grantId));

describe('bonus wagering on bets', () => {
  it("a bet on an eligible game advances the requirement by the stake at the game's contribution rate", async () => {
    const weightProfileId = await newWeightProfile([
      { scope: 'game', ref: 'game-1', percent: '50' },
      { scope: 'default', ref: null, percent: '100' },
    ]);
    const { userId, grantId } = await newGrant({ weightProfileId });

    const half = await wager(userId, { stake: '40', context: casino('game-1') });
    expect(half).toMatchObject({ ok: true, grantId, weightedAmount: money('20') });
    expect((await grantRow(grantId)).wageringProgress).toBe(money('20'));

    const full = await wager(userId, { stake: '10', context: casino('game-2') });
    expect(full).toMatchObject({ ok: true, weightedAmount: money('10') });

    const row = await grantRow(grantId);
    expect(row.wageringProgress).toBe(money('30'));
    expect(row.status).toBe('active');
    const stakes = (await entriesOf(grantId)).filter((e) => e.type === 'stake');
    expect(stakes.map((e) => [e.realAmount, e.wageringDelta]).sort()).toEqual([
      [money('10'), money('10')],
      [money('40'), money('20')],
    ]);
  });

  it('a bet on a game with no weight advances nothing', async () => {
    const weightProfileId = await newWeightProfile([
      { scope: 'game', ref: 'game-1', percent: '100' },
    ]);
    const { userId, grantId } = await newGrant({ weightProfileId });

    const outcome = await wager(userId, { stake: '50', context: casino('game-2') });

    expect(outcome).toMatchObject({ ok: true, weightedAmount: money('0') });
    const row = await grantRow(grantId);
    expect(row.wageringProgress).toBe(money('0'));
    expect(row.status).toBe('active');
    expect(row.bonusBalance).toBe(money('100'));
    const [stake] = (await entriesOf(grantId)).filter((e) => e.type === 'stake');
    expect(stake).toMatchObject({ wageringDelta: money('0'), realAmount: money('50') });
  });

  it('a bet above the max bet while a bonus is active is refused', async () => {
    const { userId, grantId } = await newGrant({ maxBet: '10' });

    const over = await wager(userId, { stake: '10.000000000000000001' });
    expect(over).toMatchObject({ ok: false, reason: 'max_bet_exceeded', maxBet: '10' });

    const round = randomUUID();
    expect(await wager(userId, { stake: '6', externalRoundId: round })).toMatchObject({
      ok: true,
    });
    const split = await wager(userId, { stake: '5', externalRoundId: round });
    expect(split).toMatchObject({ ok: false, reason: 'max_bet_exceeded', maxBet: '10' });

    const row = await grantRow(grantId);
    expect(row.wageringProgress).toBe(money('6'));
    expect(await entryTypes(grantId)).toEqual(['grant', 'stake']);
  });

  it('a bet exactly at the max bet is accepted', async () => {
    const { userId, grantId } = await newGrant({ maxBet: '10' });

    const outcome = await wager(userId, { stake: '10' });

    expect(outcome).toMatchObject({ ok: true, grantId, weightedAmount: money('10') });
    expect((await grantRow(grantId)).wageringProgress).toBe(money('10'));
    expect(await entryTypes(grantId)).toEqual(['grant', 'stake']);
  });

  it.todo('the stake is taken from bonus funds first and real funds after according to the grant');

  it('completing the requirement converts the remaining bonus balance to cash once', async () => {
    const { userId, grantId } = await newGrant({ amount: '100', multiplier: '2' });

    const completing = await wager(userId, { stake: '200' });
    expect(completing).toMatchObject({
      ok: true,
      completed: [{ grantId, convertedAmount: money('100') }],
    });
    const closed = await grantRow(grantId);
    expect(closed.status).toBe('completed');
    expect(closed.bonusBalance).toBe(money('0'));
    expect(closed.wageringProgress).toBe(money('200'));
    expect(closed.closedAt).not.toBeNull();
    expect(await entryTypes(grantId)).toEqual(['convert', 'grant', 'stake']);
    const convert = (await entriesOf(grantId)).find((e) => e.type === 'convert');
    expect(convert?.bonusAmount).toBe(money('-100'));

    const after = await wager(userId, { stake: '50' });
    expect(after).toMatchObject({ ok: true, grantId: null, completed: [] });
    expect(await entryTypes(grantId)).toEqual(['convert', 'grant', 'stake']);
  });

  it('a win while wagering credits the bonus balance and not the real balance', async () => {
    const { userId, grantId } = await newGrant({ amount: '100', multiplier: '10' });
    const bonusRound = randomUUID();
    await wager(userId, { stake: '40', fromBonus: '40', externalRoundId: bonusRound });
    expect((await grantRow(grantId)).bonusBalance).toBe(money('60'));

    const win = await settle(userId, 'win', '100', bonusRound);

    expect(win).toEqual({ bonusShare: money('100'), realShare: money('0') });
    expect((await grantRow(grantId)).bonusBalance).toBe(money('160'));
    const winEntry = (await entriesOf(grantId)).find((e) => e.type === 'win');
    expect(winEntry).toMatchObject({ bonusAmount: money('100'), balanceAfter: money('160') });

    const cashRound = randomUUID();
    await wager(userId, { stake: '10', externalRoundId: cashRound });
    const cashWin = await settle(userId, 'win', '30', cashRound);
    expect(cashWin).toEqual({ bonusShare: money('0'), realShare: money('30') });
    expect((await grantRow(grantId)).bonusBalance).toBe(money('160'));
  });

  it('a rolled-back round returns the stake and its wagering progress', async () => {
    const weightProfileId = await newWeightProfile([
      { scope: 'game', ref: 'game-1', percent: '50' },
      { scope: 'default', ref: null, percent: '100' },
    ]);
    const { userId, grantId } = await newGrant({
      amount: '100',
      multiplier: '10',
      weightProfileId,
    });
    const round = randomUUID();
    await wager(userId, { stake: '40', fromBonus: '40', externalRoundId: round });
    const staked = await grantRow(grantId);
    expect(staked.bonusBalance).toBe(money('60'));
    expect(staked.wageringProgress).toBe(money('20'));

    const reversed = await settle(userId, 'bet_reversal', '40', round);

    expect(reversed).toEqual({ bonusShare: money('40'), realShare: money('0') });
    const restored = await grantRow(grantId);
    expect(restored.bonusBalance).toBe(money('100'));
    expect(restored.wageringProgress).toBe(money('0'));
    const reversal = (await entriesOf(grantId)).find((e) => e.type === 'reversal');
    expect(reversal).toMatchObject({ bonusAmount: money('40'), wageringDelta: money('-20') });

    const again = await settle(userId, 'bet_reversal', '40', round);
    expect(again).toEqual({ bonusShare: '0', realShare: '0' });
    const unchanged = await grantRow(grantId);
    expect(unchanged.bonusBalance).toBe(money('100'));
    expect((await entryTypes(grantId)).filter((t) => t === 'reversal')).toHaveLength(1);
  });

  it.todo('a repeated bet with the same round id advances the requirement once');

  it('two grants in rollover order each receive the progress they have room for', async () => {
    const userId = randomUUID();
    const early = await newGrant({ userId, amount: '10', multiplier: '10', expiryDays: 5 });
    const late = await newGrant({ userId, amount: '100', multiplier: '10', expiryDays: 20 });

    const outcome = await wager(userId, { stake: '150' });

    expect(outcome).toMatchObject({
      ok: true,
      weightedAmount: money('150'),
      completed: [{ grantId: early.grantId, convertedAmount: money('10') }],
    });
    const first = await grantRow(early.grantId);
    expect(first.status).toBe('completed');
    expect(first.wageringProgress).toBe(money('100'));
    const second = await grantRow(late.grantId);
    expect(second.status).toBe('active');
    expect(second.wageringProgress).toBe(money('50'));
    const stakeOf = async (grantId: string) =>
      (await entriesOf(grantId)).find((e) => e.type === 'stake')?.realAmount;
    expect(await stakeOf(early.grantId)).toBe(money('100'));
    expect(await stakeOf(late.grantId)).toBe(money('50'));
  });
});

describe('grant lifecycle jobs', () => {
  it('the expiry job closes grants past their expiry and removes their bonus balance', async () => {
    const { userId, grantId } = await newGrant({ amount: '100' });
    await makeDue(grantId);

    const closed = await lifecycle.expireDue();

    expect(closed).toContainEqual({
      grantId,
      userId,
      currency: CURRENCY,
      forfeitedAmount: money('100'),
      actorId: null,
    });
    const row = await grantRow(grantId);
    expect(row.status).toBe('expired');
    expect(row.bonusBalance).toBe(money('0'));
    expect(row.closedAt).not.toBeNull();
    const expiry = (await entriesOf(grantId)).find((e) => e.type === 'expire');
    expect(expiry).toMatchObject({ bonusAmount: money('-100'), balanceAfter: money('0') });
    expect(auditFor('promo.bonus.expired', grantId)).toMatchObject([{ actorType: 'system' }]);
    expect(eventsFor('promo.bonus.expired', grantId)).toHaveLength(1);
  });

  it('the expiry job leaves active grants not yet due untouched', async () => {
    const due = await newGrant();
    const live = await newGrant();
    await makeDue(due.grantId);

    const closed = await lifecycle.expireDue();

    expect(closed.map((c) => c.grantId)).toContain(due.grantId);
    expect(closed.map((c) => c.grantId)).not.toContain(live.grantId);
    const row = await grantRow(live.grantId);
    expect(row.status).toBe('active');
    expect(row.bonusBalance).toBe(money('100'));
    expect(await entryTypes(live.grantId)).toEqual(['grant']);
  });

  it('running the expiry job twice closes each grant once', async () => {
    const { grantId } = await newGrant();
    await makeDue(grantId);

    const first = await lifecycle.expireDue();
    const second = await lifecycle.expireDue();

    expect(first.map((c) => c.grantId)).toContain(grantId);
    expect(second.map((c) => c.grantId)).not.toContain(grantId);
    expect((await entryTypes(grantId)).filter((t) => t === 'expire')).toHaveLength(1);
    expect(auditFor('promo.bonus.expired', grantId)).toHaveLength(1);
    expect(eventsFor('promo.bonus.expired', grantId)).toHaveLength(1);
  });

  it('self-exclusion of a player forfeits all of their active grants', async () => {
    const userId = randomUUID();
    const one = await newGrant({ userId, amount: '100' });
    const two = await newGrant({ userId, amount: '60' });
    const bystander = await newGrant();

    const closed = await lifecycle.forfeitAllFor(userId, 'self_exclusion');

    expect(closed.map((c) => c.grantId).sort()).toEqual([one.grantId, two.grantId].sort());
    for (const [grantId, amount] of [
      [one.grantId, '100'],
      [two.grantId, '60'],
    ] as const) {
      const row = await grantRow(grantId);
      expect(row).toMatchObject({ status: 'forfeited', forfeitReason: 'self_exclusion' });
      expect(row.bonusBalance).toBe(money('0'));
      const forfeit = (await entriesOf(grantId)).find((e) => e.type === 'forfeit');
      expect(forfeit?.bonusAmount).toBe(money(`-${amount}`));
      expect(auditFor('promo.bonus.forfeited', grantId)).toMatchObject([
        { actorType: 'system', after: { reason: 'self_exclusion' } },
      ]);
    }
    const untouched = await grantRow(bystander.grantId);
    expect(untouched.status).toBe('active');
    expect(untouched.bonusBalance).toBe(money('100'));
  });

  it('a ban of a player forfeits all of their active grants and records the reason', async () => {
    const userId = randomUUID();
    const adminId = randomUUID();
    const one = await newGrant({ userId });
    const two = await newGrant({ userId });

    await lifecycle.forfeitAllFor(userId, 'account_deactivated', { id: adminId, isAdmin: true });

    for (const { grantId } of [one, two]) {
      const row = await grantRow(grantId);
      expect(row).toMatchObject({
        status: 'forfeited',
        forfeitReason: 'account_deactivated',
        forfeitedBy: adminId,
      });
      expect(row.bonusBalance).toBe(money('0'));
      expect(auditFor('promo.bonus.forfeited', grantId)).toMatchObject([
        { actorType: 'admin', actorId: adminId, after: { reason: 'account_deactivated' } },
      ]);
      expect(eventsFor('promo.bonus.forfeited', grantId)).toMatchObject([
        { payload: { reason: 'account_deactivated', actorId: adminId } },
      ]);
    }
  });

  it('a forfeit job retried after a partial run forfeits only the grants still active', async () => {
    const userId = randomUUID();
    const done = await newGrant({ userId });
    const pending = await newGrant({ userId });
    await lifecycle.forfeit({ grantId: done.grantId, reason: 'self_exclusion', note: 'partial' });

    const retried = await lifecycle.forfeitAllFor(userId, 'self_exclusion');

    expect(retried.map((c) => c.grantId)).toEqual([pending.grantId]);
    expect((await entryTypes(done.grantId)).filter((t) => t === 'forfeit')).toHaveLength(1);
    expect(auditFor('promo.bonus.forfeited', done.grantId)).toHaveLength(1);
    expect(await lifecycle.forfeitAllFor(userId, 'self_exclusion')).toEqual([]);
    expect(auditFor('promo.bonus.forfeited', pending.grantId)).toHaveLength(1);
  });

  it('the deposit job grants the bonus once when the transaction is delivered twice', async () => {
    const userId = randomUUID();
    const [offer] = await db.drizzle.db
      .insert(promoOffer)
      .values({
        key: `welcome-${randomUUID()}`,
        name: 'Welcome',
        status: 'active',
        currency: CURRENCY,
        matchPercent: '100',
        maxGrantAmount: '1000',
        minDeposit: '10',
        terms: { wageringMultiplier: '10', expiryDays: 30 },
        rules: { firstDepositOnly: false },
        requiresOptIn: true,
      })
      .returning({ id: promoOffer.id });
    if (!offer) {
      throw new Error('offer insert returned no row');
    }
    await offers.optIn(userId, offer.id, { isFirstDeposit: true });
    const deposit = { userId, amount: '50', currency: CURRENCY, transactionId: randomUUID() };

    const first = await db.drizzle.db.transaction((tx) => offers.applyDeposit(tx, deposit));
    const redelivered = await db.drizzle.db.transaction((tx) => offers.applyDeposit(tx, deposit));
    const laterDeposit = await db.drizzle.db.transaction((tx) =>
      offers.applyDeposit(tx, { ...deposit, transactionId: randomUUID() }),
    );

    expect(first).toMatchObject([
      {
        userId,
        offerId: offer.id,
        grantedAmount: money('50'),
        wageringRequired: money('500'),
      },
    ]);
    expect(redelivered).toEqual([]);
    expect(laterDeposit).toEqual([]);
    const held = await db.drizzle.db.select().from(promoGrant).where(eq(promoGrant.userId, userId));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ bonusBalance: money('50'), source: 'deposit' });
    const [claim] = await db.drizzle.db
      .select()
      .from(promoOptIn)
      .where(eq(promoOptIn.userId, userId));
    expect(claim).toMatchObject({ grantId: held[0]?.id, accumulatedDeposit: money('50') });
    const counted = await db.drizzle.db
      .select()
      .from(promoOptInDeposit)
      .where(eq(promoOptInDeposit.optInId, claim?.id ?? ''));
    expect(counted).toHaveLength(1);
  });
});

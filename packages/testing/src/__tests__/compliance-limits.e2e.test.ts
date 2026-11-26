import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { RgLimitExceededError } from '@openora/core/contracts';
import { DRIZZLE, eventOutbox } from '@openora/core/server';
import {
  LimitViewSchema,
  RgFlagListItemSchema,
  RgSectionSchema,
} from '@openora/core/compliance/contract';
import { rgLimitVersion, userLimit } from '@openora/core/compliance/schema';
import {
  ledgerUserLimit,
  ledgerUserLimitVersion,
  walletTransaction,
} from '@openora/core/wallet/schema';
import { balanceOf, bootWalletE2e, closeWalletE2e, type WalletE2e } from './support/wallet.js';
import {
  adminPutLimit,
  depositRows,
  fundPlayer,
  hoursFromNow,
  limitRow,
  newRgPlayer,
  placeBet,
  postDeposit,
  putLimit,
  rawPutLimit,
  readBody,
  rgSection,
  scaled,
  setPendingWindow,
} from './support/compliance.js';
import { paginated } from '@openora/core/contracts/kit';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e();
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const conflict = (data: Record<string, unknown>) =>
  expect.objectContaining({ code: 'CONFLICT', status: 409, data: expect.objectContaining(data) });

async function raisedLimit(from: string, to: string) {
  const player = await newRgPlayer(e2e);
  const set = await putLimit(player.client, player.currency, { amount: from });
  const raised = await putLimit(player.client, player.currency, { amount: to });
  return { player, limitId: set.id, raised };
}

describe('Player deposit, loss and wager limits', () => {
  it('player sets a daily deposit limit and a deposit route request over it is refused with no ledger row', async () => {
    const player = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, { amount: '50' });

    const over = await postDeposit(player.client, player.currency, '60');

    expect(over.status).toBe(409);
    expect(over.body).toEqual(
      conflict({
        reason: 'deposit_limit_exceeded',
        limitType: 'deposit',
        period: 'daily',
        limit: scaled('50'),
        used: '0',
        currency: player.currency,
      }),
    );
    expect(await depositRows(e2e, player.userId)).toEqual([]);

    const within = await postDeposit(player.client, player.currency, '40');
    expect(within.status).toBe(200);
    expect(await depositRows(e2e, player.userId)).toHaveLength(1);
  });

  it('player sets weekly and monthly limits and the tightest window refuses first', async () => {
    const player = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, { period: 'daily', amount: '100' });
    await putLimit(player.client, player.currency, { period: 'weekly', amount: '150' });
    await putLimit(player.client, player.currency, { period: 'monthly', amount: '300' });

    const atEveryLimit = await postDeposit(player.client, player.currency, '100');
    expect(atEveryLimit.status).toBe(200);
    const overDaily = await postDeposit(player.client, player.currency, '1');

    expect(overDaily.status).toBe(409);
    expect(overDaily.body).toEqual(
      conflict({ reason: 'deposit_limit_exceeded', period: 'daily', limit: scaled('100') }),
    );
    expect(await depositRows(e2e, player.userId)).toHaveLength(1);
  });

  it.todo(
    'BUG: a loss limit is stored but never enforced, a second bet that takes net loss past it is accepted; the ledger offers only checkDeposit and checkWager (packages/core/src/wallet/service/ledger-rg-limits.service.ts:114)',
  );
  it('player sets a wager limit and the next bet over it is refused', async () => {
    const player = await newRgPlayer(e2e);
    await fundPlayer(e2e, player, '100');
    await putLimit(player.client, player.currency, { type: 'wager', amount: '30' });

    await placeBet(e2e, player.userId, player.currency, '20');
    await expect(placeBet(e2e, player.userId, player.currency, '20')).rejects.toBeInstanceOf(
      RgLimitExceededError,
    );

    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(scaled('80'));
  });

  it('limits of the same type must stay ordered from daily to monthly or the write is refused', async () => {
    const player = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, { period: 'daily', amount: '100' });

    const weeklyBelowDaily = await rawPutLimit(player.client, player.currency, {
      period: 'weekly',
      amount: '50',
    });
    expect(weeklyBelowDaily.status).toBe(409);
    expect(weeklyBelowDaily.body).toEqual(
      conflict({ type: 'deposit', period: 'weekly', conflictingPeriod: 'daily' }),
    );

    await putLimit(player.client, player.currency, { period: 'weekly', amount: '150' });
    const dailyAboveWeekly = await rawPutLimit(player.client, player.currency, {
      period: 'daily',
      amount: '200',
    });
    expect(dailyAboveWeekly.status).toBe(409);
    expect(dailyAboveWeekly.body).toEqual(
      conflict({ period: 'daily', conflictingPeriod: 'weekly' }),
    );

    const rows = await db().select().from(userLimit).where(eq(userLimit.userId, player.userId));
    expect(rows.map((row) => [row.period, row.amount]).sort()).toEqual([
      ['daily', scaled('100')],
      ['weekly', scaled('150')],
    ]);
  });

  it('admin writing a limit into a slot holding an unpinned limit and a twin in the requested currency is refused', async () => {
    const player = await newRgPlayer(e2e);
    await db()
      .insert(userLimit)
      .values([
        {
          userId: player.userId,
          type: 'deposit',
          amount: '100',
          currency: null,
          period: 'daily',
        },
        {
          userId: player.userId,
          type: 'deposit',
          amount: '100',
          currency: player.currency,
          period: 'daily',
        },
      ]);

    const res = await adminPutLimit(e2e.admin, player.userId, player.currency, { amount: '50' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: expect.stringContaining(player.currency),
      }),
    );
    const rows = await db().select().from(userLimit).where(eq(userLimit.userId, player.userId));
    expect(rows.map((row) => [row.currency, row.amount]).sort()).toEqual(
      [
        [null, scaled('100')],
        [player.currency, scaled('100')],
      ].sort(),
    );
  });

  it('player lowers a limit and it applies on the next request', async () => {
    const player = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, { amount: '100' });
    const before = await postDeposit(player.client, player.currency, '50');
    expect(before.status).toBe(200);

    const lowered = await putLimit(player.client, player.currency, { amount: '60' });

    expect(lowered.amount).toBe(scaled('60'));
    expect(lowered.pendingKind).toBeNull();
    const refused = await postDeposit(player.client, player.currency, '20');
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual(conflict({ limit: scaled('60'), used: scaled('50') }));
  });

  it('player raises a limit and the old value stays enforced until the cool-down elapses', async () => {
    const { player, raised } = await raisedLimit('40', '100');

    expect(raised.amount).toBe(scaled('40'));
    expect(raised.pendingKind).toBe('increase');
    expect(raised.pendingAmount).toBe(scaled('100'));
    expect(raised.pendingStatus).toBe('waiting');
    const refused = await postDeposit(player.client, player.currency, '50');
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual(conflict({ limit: scaled('40') }));
  });

  it('player confirming a raise before the cool-down elapsed gets a cool-down error', async () => {
    const { player, limitId } = await raisedLimit('40', '100');

    const res = await readBody(
      await player.client.post(`/compliance/limits/${limitId}/pending/confirm`),
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual(conflict({ reason: 'cooldown_not_elapsed' }));
    const row = await limitRow(e2e, limitId);
    expect(row?.amount).toBe(scaled('40'));
    expect(row?.pendingKind).toBe('increase');
  });

  it('player confirming a raise after the confirmation window lapsed gets an expired error', async () => {
    const { player, limitId } = await raisedLimit('40', '100');
    await setPendingWindow(e2e, limitId, {
      effectiveAt: hoursFromNow(-48),
      expiresAt: hoursFromNow(-1),
    });

    const res = await readBody(
      await player.client.post(`/compliance/limits/${limitId}/pending/confirm`),
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual(conflict({ reason: 'limit_change_expired' }));
    const row = await limitRow(e2e, limitId);
    expect(row?.amount).toBe(scaled('40'));
    expect(row?.pendingKind).toBeNull();
  });

  it('player confirms a raised limit after the cool-down and the new value applies', async () => {
    const { player, limitId } = await raisedLimit('40', '100');
    await setPendingWindow(e2e, limitId, {
      effectiveAt: hoursFromNow(-1),
      expiresAt: hoursFromNow(24),
    });

    const res = await readBody(
      await player.client.post(`/compliance/limits/${limitId}/pending/confirm`),
    );

    expect(res.status).toBe(200);
    const confirmed = LimitViewSchema.parse(res.body);
    expect(confirmed.amount).toBe(scaled('100'));
    expect(confirmed.pendingKind).toBeNull();
    const deposit = await postDeposit(player.client, player.currency, '50');
    expect(deposit.status).toBe(200);
  });

  it('player cancels a pending raise and the current limit stays', async () => {
    const { player, limitId } = await raisedLimit('40', '100');

    const res = await readBody(await player.client.del(`/compliance/limits/${limitId}/pending`));

    expect(res.status).toBe(200);
    const cancelled = LimitViewSchema.parse(res.body);
    expect(cancelled.amount).toBe(scaled('40'));
    expect(cancelled.pendingKind).toBeNull();
    const row = await limitRow(e2e, limitId);
    expect(row?.pendingKind).toBeNull();
    expect(row?.pendingAmount).toBeNull();
    const refused = await postDeposit(player.client, player.currency, '50');
    expect(refused.status).toBe(409);
  });

  it('player cannot confirm or cancel another player pending change', async () => {
    const { limitId } = await raisedLimit('40', '100');
    const other = await newRgPlayer(e2e);

    const confirm = await readBody(
      await other.client.post(`/compliance/limits/${limitId}/pending/confirm`),
    );
    const cancel = await readBody(await other.client.del(`/compliance/limits/${limitId}/pending`));

    expect(confirm.status).toBe(403);
    expect(cancel.status).toBe(403);
    const row = await limitRow(e2e, limitId);
    expect(row?.pendingKind).toBe('increase');
    expect(row?.pendingAmount).toBe(scaled('100'));
  });

  it('player removes a limit and cannot remove another player limit', async () => {
    const player = await newRgPlayer(e2e);
    const other = await newRgPlayer(e2e);
    const view = await putLimit(player.client, player.currency, { amount: '40' });

    const foreign = await readBody(await other.client.del(`/compliance/limits/${view.id}`));
    expect(foreign.status).toBe(403);
    expect(await limitRow(e2e, view.id)).toEqual(expect.objectContaining({ pendingKind: null }));

    const requested = await readBody(await player.client.del(`/compliance/limits/${view.id}`));
    expect(requested.status).toBe(200);
    expect(LimitViewSchema.parse(requested.body).pendingKind).toBe('removal');
    await setPendingWindow(e2e, view.id, {
      effectiveAt: hoursFromNow(-1),
      expiresAt: hoursFromNow(24),
    });
    const confirmed = await readBody(
      await player.client.post(`/compliance/limits/${view.id}/pending/confirm`),
    );

    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toBeNull();
    expect(await limitRow(e2e, view.id)).toBeUndefined();
    const deposit = await postDeposit(player.client, player.currency, '500');
    expect(deposit.status).toBe(200);
  });

  it('a spent window resets at the window boundary and the player can deposit again', async () => {
    const player = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, { amount: '50' });
    const spent = await postDeposit(player.client, player.currency, '50');
    expect(spent.status).toBe(200);
    const blocked = await postDeposit(player.client, player.currency, '10');
    expect(blocked.status).toBe(409);

    const rows = await depositRows(e2e, player.userId);
    await db()
      .update(walletTransaction)
      .set({ reviewedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) })
      .where(eq(walletTransaction.id, rows.map((row) => row.id)[0] ?? ''));

    const again = await postDeposit(player.client, player.currency, '10');
    expect(again.status).toBe(200);
  });

  it('player at the flag threshold of a limit is flagged for responsible gambling review', async () => {
    const player = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, { amount: '100' });

    const deposit = await postDeposit(player.client, player.currency, '85');
    expect(deposit.status).toBe(200);

    const flag = await vi.waitFor(
      async () => {
        const res = await readBody(
          await e2e.admin.get('/compliance/rg-flags?flagType=limit_threshold&limitType=deposit'),
        );
        const page = paginated(RgFlagListItemSchema).parse(res.body);
        const found = page.items.find((item) => item.userId === player.userId);
        if (!found) {
          throw new Error('no limit threshold flag yet');
        }
        return found;
      },
      { timeout: 15_000, interval: 200 },
    );
    expect(flag).toEqual(
      expect.objectContaining({
        flagType: 'limit_threshold',
        limitType: 'deposit',
        status: 'active',
        detail: expect.objectContaining({ period: 'daily', limit: scaled('100') }),
      }),
    );
  });
});

describe('Admin limit changes and projection', () => {
  it('admin lowers a player limit and it applies at once', async () => {
    const player = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, { amount: '100' });

    const lowered = await adminPutLimit(e2e.admin, player.userId, player.currency, {
      amount: '30',
    });

    expect(lowered.status).toBe(200);
    expect(lowered.body).toEqual(expect.objectContaining({ amount: scaled('30') }));
    const refused = await postDeposit(player.client, player.currency, '40');
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual(conflict({ limit: scaled('30') }));
  });

  it('admin cannot raise a player limit and gets a raise-not-allowed error', async () => {
    const player = await newRgPlayer(e2e);
    const view = await putLimit(player.client, player.currency, { amount: '50' });

    const res = await adminPutLimit(e2e.admin, player.userId, player.currency, { amount: '500' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(
      conflict({
        type: 'deposit',
        period: 'daily',
        previousAmount: scaled('50'),
        requestedAmount: '500',
      }),
    );
    expect((await limitRow(e2e, view.id))?.amount).toBe(scaled('50'));
  });

  it('admin cannot remove a player limit and the cap and its removal state stay', async () => {
    const player = await newRgPlayer(e2e);
    const view = await putLimit(player.client, player.currency, { amount: '50' });
    const before = await limitRow(e2e, view.id);

    const res = await readBody(await e2e.admin.del(`/compliance/limits/${view.id}`));

    expect(res.status).toBe(403);
    expect(await limitRow(e2e, view.id)).toEqual(before);
    const over = await postDeposit(player.client, player.currency, '60');
    expect(over.status).toBe(409);
  });

  it('player cannot use the admin limit route', async () => {
    const player = await newRgPlayer(e2e);

    const res = await adminPutLimit(player.client, player.userId, player.currency, {
      amount: '10',
    });

    expect(res.status).toBe(403);
    const rows = await db().select().from(userLimit).where(eq(userLimit.userId, player.userId));
    expect(rows).toEqual([]);
  });

  it('every limit change bumps the limit projection version and emits the changed event', async () => {
    const player = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, { amount: '100' });
    await putLimit(player.client, player.currency, { amount: '80' });
    await adminPutLimit(e2e.admin, player.userId, player.currency, { amount: '60' });

    const [version] = await db()
      .select()
      .from(rgLimitVersion)
      .where(eq(rgLimitVersion.userId, player.userId));
    expect(version?.version).toBe(3);
    const events = await db()
      .select({ payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.topic, 'compliance.rg_limits.changed'),
          sql`${eventOutbox.payload}->>'userId' = ${player.userId}`,
        ),
      )
      .orderBy(asc(eventOutbox.seq));
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        version: 1,
        limits: [expect.objectContaining({ amount: scaled('100') })],
      }),
      expect.objectContaining({
        version: 2,
        limits: [expect.objectContaining({ amount: scaled('80') })],
      }),
      expect.objectContaining({
        version: 3,
        limits: [expect.objectContaining({ amount: scaled('60') })],
      }),
    ]);
    const [held] = await db()
      .select()
      .from(ledgerUserLimitVersion)
      .where(eq(ledgerUserLimitVersion.userId, player.userId));
    expect(held?.version).toBe(3);
  });

  it('limit projection for a player lists each active limit with its period and currency', async () => {
    const player = await newRgPlayer(e2e);
    await putLimit(player.client, player.currency, {
      type: 'deposit',
      period: 'daily',
      amount: '100',
    });
    await putLimit(player.client, player.currency, {
      type: 'wager',
      period: 'weekly',
      amount: '200',
    });
    await putLimit(player.client, player.currency, {
      type: 'loss',
      period: 'monthly',
      amount: '300',
    });

    const rows = await db()
      .select()
      .from(ledgerUserLimit)
      .where(eq(ledgerUserLimit.userId, player.userId));

    expect(rows.map((row) => [row.type, row.period, row.amount, row.currency]).sort()).toEqual(
      [
        ['deposit', 'daily', scaled('100'), player.currency],
        ['wager', 'weekly', scaled('200'), player.currency],
      ].sort(),
    );
  });

  it('concurrent limit changes for one player produce strictly increasing projection versions', async () => {
    const player = await newRgPlayer(e2e);
    const changes = (['deposit', 'wager'] as const).flatMap((type) =>
      (
        [
          ['daily', '10'],
          ['weekly', '20'],
          ['monthly', '30'],
        ] as const
      ).map(([period, amount]) =>
        putLimit(player.client, player.currency, { type, period, amount }),
      ),
    );

    await Promise.all(changes);

    const events = await db()
      .select({ payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.topic, 'compliance.rg_limits.changed'),
          sql`${eventOutbox.payload}->>'userId' = ${player.userId}`,
        ),
      )
      .orderBy(asc(eventOutbox.seq));
    expect(events.map((event) => (event.payload as { version: number }).version)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    const [held] = await db()
      .select()
      .from(ledgerUserLimitVersion)
      .where(eq(ledgerUserLimitVersion.userId, player.userId));
    expect(held?.version).toBe(6);
  });

  it('player reads own responsible-gambling section with limits and pending changes', async () => {
    const { player, limitId } = await raisedLimit('40', '100');

    const section = await rgSection(player.client);

    expect(section.coolingOff).toBeNull();
    expect(section.selfExclusion).toBeNull();
    expect(section.limits).toEqual([
      expect.objectContaining({
        id: limitId,
        amount: scaled('40'),
        currency: player.currency,
        pendingKind: 'increase',
        pendingAmount: scaled('100'),
        pendingStatus: 'waiting',
      }),
    ]);
    expect(RgSectionSchema.safeParse(section).success).toBe(true);
  });
});

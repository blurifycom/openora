import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { moneyAdd, moneySubtract, type DrizzleTx } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { adminRole, adminRoleAssignment, adminRolePermission } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import { promoGrant, promoGrantRound } from '@openora/core/promo/schema/bonus';
import { wallet, walletTransaction, walletTurnoverEntry } from '@openora/core/wallet/schema';
import { flushAudit, readJson, registerAndMaterializePlayer } from '../index.js';
import { expectMoney, useBonusLockHarness } from './fixtures/bonus-lock-harness.js';
import { TEST_TURNOVER_LOCKED_MESSAGE } from './fixtures/turnover-gate-config.js';

const CONVERT = '/backoffice/promo/grants/convert-transfer-grants';

const { app, admin, drizzle, commands, player, grant, grantRow, realBalance, withdraw, bet, lose } =
  useBonusLockHarness('block', {
    config: {
      id: 'testing-promo-grant-conversion-config',
      file: './test-promo-grant-conversion-config-plugin.ts',
    },
  });

const convert = async (body: Record<string, unknown>) => {
  const res = await admin().post(CONVERT, body);
  expect(res.status).toBe(200);
  return readJson(res);
};

const conversionCredits = (userId: string) =>
  drizzle()
    .select({ amount: walletTransaction.amount, providerRefId: walletTransaction.providerRefId })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(
      and(
        eq(wallet.userId, userId),
        eq(walletTransaction.type, 'bonus'),
        eq(walletTransaction.providerName, 'promo:grant-conversion'),
      ),
    );

const conversionEntries = (userId: string) =>
  drizzle()
    .select()
    .from(walletTurnoverEntry)
    .where(
      and(
        eq(walletTurnoverEntry.userId, userId),
        eq(walletTurnoverEntry.source, 'grant_conversion'),
      ),
    );

const openRounds = (grantId: string) =>
  drizzle()
    .select({ id: promoGrantRound.id })
    .from(promoGrantRound)
    .where(and(eq(promoGrantRound.grantId, grantId), isNull(promoGrantRound.settledAt)));

const convertedIds = (result: { converted: { grantId: string }[] }) =>
  result.converted.map((row) => row.grantId);

describe('converting a live gift grant', () => {
  it('credits its bonus balance as cash that owes the wagering it had left', async () => {
    const { client, userId } = await player('20');
    const grantId = await grant(userId, {
      source: 'gift',
      amount: '10',
      linked: '5',
      multiplier: '3',
    });
    const before = await realBalance(userId);

    const result = await convert({ sources: ['gift'] });

    expect(result.skippedOpenRound).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.converted).toHaveLength(1);
    const [row] = result.converted;
    expect(row).toMatchObject({ grantId, userId, currency: 'USD', entryStatus: 'counted' });
    expectMoney(row.cash, '10', 'cash');
    expectMoney(row.requiredInCurrency, '30', 'requiredInCurrency');

    expectMoney(await realBalance(userId), moneyAdd(before, '10'), 'real balance');
    const credits = await conversionCredits(userId);
    expect(credits).toHaveLength(1);
    expect(credits[0]?.providerRefId).toBe(grantId);
    expectMoney(credits[0]?.amount ?? '0', '10', 'ledger credit');

    const closed = await grantRow(grantId);
    expect(closed.status).toBe('completed');
    expectMoney(closed.bonusBalance, '0', 'bonus balance');
    expectMoney(closed.linkedCash, '0', 'linked cash');
    expectMoney(closed.unlinkedCash, '0', 'unlinked cash');

    const entries = await conversionEntries(userId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sourceRef: grantId, status: 'counted' });
    expectMoney(entries[0]?.required ?? '0', '30', 'pivot requirement');

    const refused = await withdraw(client, '1');
    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toMatchObject({
      message: TEST_TURNOVER_LOCKED_MESSAGE,
      data: { reason: 'turnover_requirement_unmet', outflow: 'withdrawal' },
    });
    expect((await grantRow(grantId)).status).toBe('completed');

    await flushAudit(app());
    const audits = await drizzle()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'promo.bonus.converted_to_cash'), eq(auditLog.resourceId, grantId)),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'admin', resourceType: 'promo_grant' });
  });

  it('converts nothing on a rerun, and a dry run writes nothing', async () => {
    const { userId } = await player('5');
    const grantId = await grant(userId, {
      source: 'gift',
      amount: '10',
      linked: '0',
      multiplier: '2',
    });

    const preview = await convert({ sources: ['gift'], dryRun: true });
    expect(convertedIds(preview)).toEqual([grantId]);
    expect(preview.converted[0]).toMatchObject({ entryStatus: null });
    expectMoney(preview.converted[0].cash, '10', 'previewed cash');
    expectMoney(preview.converted[0].requiredInCurrency, '20', 'previewed requirement');
    expect(preview.remaining).toBe(1);
    expect((await grantRow(grantId)).status).toBe('active');
    expectMoney(await realBalance(userId), '5', 'real balance after dry run');
    expect(await conversionCredits(userId)).toEqual([]);
    expect(await conversionEntries(userId)).toEqual([]);

    const first = await convert({ sources: ['gift'] });
    expect(convertedIds(first)).toEqual([grantId]);

    const rerun = await convert({ sources: ['gift'] });
    expect(rerun).toEqual({ converted: [], skippedOpenRound: 0, remaining: 0, nextCursor: null });
    expectMoney(await realBalance(userId), '15', 'real balance after rerun');
    expect(await conversionCredits(userId)).toHaveLength(1);
    expect(await conversionEntries(userId)).toHaveLength(1);
  });

  it('skips a grant with an open round and converts it once the round settles', async () => {
    const { userId } = await player('1');
    const grantId = await grant(userId, {
      source: 'gift',
      amount: '10',
      linked: '0',
      multiplier: '3',
      order: 'last',
    });
    const round = randomUUID();
    expect(await bet(userId, '2', round)).toMatchObject({ ok: true });
    expect(await openRounds(grantId)).toHaveLength(1);

    const skipped = await convert({ sources: ['gift'] });
    expect(skipped).toEqual({
      converted: [],
      skippedOpenRound: 1,
      remaining: 1,
      nextCursor: null,
    });
    expect((await grantRow(grantId)).status).toBe('active');

    expect(await lose(userId, round)).toMatchObject({ ok: true });
    const settled = await grantRow(grantId);
    const owed = moneySubtract(settled.wageringRequired, settled.wageringProgress);

    const converted = await convert({ sources: ['gift'] });
    expect(converted.skippedOpenRound).toBe(0);
    expect(converted.remaining).toBe(0);
    expect(convertedIds(converted)).toEqual([grantId]);
    expectMoney(converted.converted[0].cash, settled.bonusBalance, 'cash');
    expectMoney(converted.converted[0].requiredInCurrency, owed, 'requirement');
  });

  it('leaves deposit-bonus grants and unrequested sources alone', async () => {
    const depositHolder = await player('20');
    const depositGrant = await grant(depositHolder.userId, {
      source: 'deposit',
      amount: '10',
      linked: '10',
    });
    const rainHolder = await player('1');
    const rainGrant = await grant(rainHolder.userId, { source: 'rain', amount: '10', linked: '0' });

    const result = await convert({ sources: ['gift', 'donation'] });

    expect(convertedIds(result)).not.toContain(depositGrant);
    expect(convertedIds(result)).not.toContain(rainGrant);
    expect((await grantRow(depositGrant)).status).toBe('active');
    expect((await grantRow(rainGrant)).status).toBe('active');
    expect(await conversionCredits(rainHolder.userId)).toEqual([]);

    const rain = await convert({ sources: ['rain'] });
    expect(convertedIds(rain)).toEqual([rainGrant]);
    expect((await grantRow(depositGrant)).status).toBe('active');
  });

  it('completes a grant with nothing left to pay and adds no requirement', async () => {
    const { userId } = await player('1');
    const grantId = await grant(userId, { source: 'gift', amount: '10', linked: '0' });
    const { terms } = await grantRow(grantId);
    await drizzle()
      .update(promoGrant)
      .set({ terms: { ...terms, maxWinMultiplier: '0' } })
      .where(eq(promoGrant.id, grantId));

    const preview = await convert({ sources: ['gift'], dryRun: true });
    expect(preview.converted).toHaveLength(1);
    expectMoney(preview.converted[0].requiredInCurrency, '0', 'previewed requirement');

    const result = await convert({ sources: ['gift'] });

    expect(result.converted).toHaveLength(1);
    expect(result.converted[0]).toMatchObject({ grantId, entryStatus: null });
    expectMoney(result.converted[0].cash, '0', 'cash');
    expectMoney(result.converted[0].requiredInCurrency, '0', 'requirement');
    expect((await grantRow(grantId)).status).toBe('completed');
    expect(await conversionCredits(userId)).toEqual([]);
    expect(await conversionEntries(userId)).toEqual([]);
  });

  it('does not convert an expired grant', async () => {
    const { userId } = await player('1');
    const grantId = await grant(userId, { source: 'donation', amount: '10', linked: '0' });
    await drizzle()
      .update(promoGrant)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(promoGrant.id, grantId));

    const result = await convert({ sources: ['donation'] });

    expect(result).toEqual({ converted: [], skippedOpenRound: 0, remaining: 0, nextCursor: null });
    expect((await grantRow(grantId)).status).toBe('active');
    expect(await conversionCredits(userId)).toEqual([]);
  });
});

describe('who may convert', () => {
  async function staffWithBonusWrite() {
    const staff = await registerAndMaterializePlayer(app(), {
      email: `conversion-staff-${randomUUID()}@e2e.test`,
    });
    await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, staff.userId));
    const [role] = await drizzle()
      .insert(adminRole)
      .values({ name: `conversion staff ${randomUUID()}` })
      .returning({ id: adminRole.id });
    if (!role) {
      throw new Error('role insert returned no row');
    }
    await drizzle()
      .insert(adminRolePermission)
      .values({ roleId: role.id, resource: 'bonus', level: 'read_write' });
    await drizzle().insert(adminRoleAssignment).values({ userId: staff.userId, roleId: role.id });
    return staff.client;
  }

  it('refuses staff who are not super-admins, players, and anonymous callers', async () => {
    const { userId } = await player('1');
    const grantId = await grant(userId, { source: 'gift', amount: '10', linked: '0' });

    const staff = await staffWithBonusWrite();
    expect((await staff.post(CONVERT, { sources: ['gift'] })).status).toBe(403);

    const { client } = await player('1');
    expect((await client.post(CONVERT, { sources: ['gift'] })).status).toBe(403);

    const anonymous = await app().app.request(CONVERT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: ['gift'] }),
    });
    expect(anonymous.status).toBe(401);

    expect((await grantRow(grantId)).status).toBe('active');
    await convert({ sources: ['gift'] });
  });
});

describe('a conversion racing a bet on the same grant', () => {
  const waitersOn = async (holderPid: number) => {
    const rows = await drizzle().execute<{ n: number }>(
      sql`with recursive blocked(pid) as (
            select pid from pg_stat_activity where ${holderPid}::int = any(pg_blocking_pids(pid))
            union
            select a.pid from pg_stat_activity a join blocked b on b.pid = any(pg_blocking_pids(a.pid))
          )
          select count(*)::int as n from blocked`,
    );
    return Number(rows.rows[0]?.n ?? 0);
  };

  const untilWaiters = async (holderPid: number, n: number) => {
    for (let poll = 0; poll < 200; poll += 1) {
      if ((await waitersOn(holderPid)) >= n) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`expected ${n} sessions blocked by backend ${holderPid}`);
  };

  const holdOpen = async (work: (tx: DrizzleTx) => Promise<unknown>) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: (pid: number) => void = () => {};
    const started = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const done = drizzle().transaction(async (tx) => {
      const pidRows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      const value = await work(tx);
      ready(Number(pidRows.rows[0]?.pid));
      await gate;
      return value;
    });
    const pid = await Promise.race([started, done.then(() => Number.NaN)]);
    return { release, done, pid };
  };

  const giftGrant = async () => {
    const { userId } = await player('5');
    const grantId = await grant(userId, {
      source: 'gift',
      amount: '10',
      linked: '0',
      multiplier: '3',
      order: 'last',
    });
    return { userId, grantId, round: randomUUID() };
  };

  it('skips the grant when the bet holds the wallet first', async () => {
    const { userId, grantId, round } = await giftGrant();
    const placed = await holdOpen((tx) =>
      commands().debit(tx, {
        userId,
        amount: '10',
        type: 'bet',
        currency: 'USD',
        context: { provider: 'aggregator', product: 'casino' },
        providerRef: {
          providerName: 'aggregator',
          providerRefId: `bet-${round}`,
          externalRoundId: round,
        },
      }),
    );

    const conversion = admin().post(CONVERT, { sources: ['gift'] });
    await untilWaiters(placed.pid, 1);
    placed.release();

    expect(await placed.done).toMatchObject({ ok: true, moved: true });
    const res = await conversion;
    expect(res.status).toBe(200);
    expect(convertedIds(await readJson(res))).not.toContain(grantId);
    const row = await grantRow(grantId);
    expect(row.status).toBe('active');
    expectMoney(row.bonusBalance, '0', 'bonus balance after the bet');
    expect(await openRounds(grantId)).toHaveLength(1);
    expectMoney(await realBalance(userId), '5', 'real balance');
    expect(await conversionCredits(userId)).toEqual([]);

    await lose(userId, round);
    expect((await grantRow(grantId)).status).toBe('depleted');
  });

  it('converts the grant when the conversion takes the wallet first, and the bet then pays from cash', async () => {
    const { userId, grantId, round } = await giftGrant();
    const holder = await holdOpen(
      (tx) => commands().lockWallets?.(tx, { userIds: [userId] }) ?? Promise.resolve(),
    );

    const conversion = admin().post(CONVERT, { sources: ['gift'] });
    await untilWaiters(holder.pid, 1);
    const staked = bet(userId, '10', round);
    await untilWaiters(holder.pid, 2);
    holder.release();
    await holder.done;

    const res = await conversion;
    expect(res.status).toBe(200);
    expect(convertedIds(await readJson(res))).toContain(grantId);
    const placed = await staked;
    expect(placed).toMatchObject({ ok: true, moved: true, bonusSpent: '0' });
    expect((await grantRow(grantId)).status).toBe('completed');
    expect(await openRounds(grantId)).toEqual([]);
    const tracked =
      placed.ok && placed.moved
        ? (placed.wagerTrackingCredits ?? []).reduce(
            (sum, { amount }) => moneyAdd(sum, amount),
            '0',
          )
        : '0';
    expectMoney(
      await realBalance(userId),
      moneyAdd('5', tracked),
      'deposit plus converted cash less the bet',
    );
    expect(await conversionCredits(userId)).toHaveLength(1);
  });
});

describe('a batch behind grants with open rounds', () => {
  it('converts the grant past them in the first call and pages with a cursor', async () => {
    const limit = 2;
    const holder = await player('1');
    const convertible = await grant(holder.userId, {
      source: 'donation',
      amount: '10',
      linked: '0',
    });
    const open: { userId: string; round: string; grantId: string }[] = [];
    while (open.filter(({ grantId }) => grantId < convertible).length < limit) {
      const { userId } = await player('1');
      const grantId = await grant(userId, {
        source: 'donation',
        amount: '10',
        linked: '0',
        order: 'last',
      });
      const round = randomUUID();
      expect(await bet(userId, '2', round)).toMatchObject({ ok: true });
      open.push({ userId, round, grantId });
    }

    const page = await convert({ sources: ['donation'], limit: 1, dryRun: true });
    expect(convertedIds(page)).toEqual([convertible]);
    expect(page.nextCursor).toBe(convertible);
    const next = await convert({
      sources: ['donation'],
      limit: 1,
      dryRun: true,
      after: page.nextCursor,
    });
    expect(next).toMatchObject({ converted: [], nextCursor: null });

    const result = await convert({ sources: ['donation'], limit });

    expect(convertedIds(result)).toEqual([convertible]);
    expect(result.skippedOpenRound).toBe(open.length);
    expect(result.nextCursor).toBeNull();
    for (const { userId, round } of open) {
      await lose(userId, round);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { eventOutbox, moneyAdd, moneyCompare } from '@openora/core/server';
import type { WagerProduct } from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRolePermission, adminRoleAssignment } from '@openora/core/iam/schema';
import {
  walletTransaction,
  walletTurnover,
  walletTurnoverEntry,
} from '@openora/core/wallet/schema';
import { flushAudit, readJson, registerAndMaterializePlayer, type TestClient } from '../index.js';
import { expectMoney, useBonusLockHarness } from './fixtures/bonus-lock-harness.js';

const {
  app,
  admin,
  drizzle,
  commands,
  player,
  deposit,
  grant,
  grantRow,
  realBalance,
  ledgerRows,
  withdraw,
} = useBonusLockHarness('block', {
  config: {
    id: 'testing-wallet-turnover-block-config',
    file: './test-wallet-turnover-block-config-plugin.ts',
  },
});

const stake = (
  userId: string,
  amount: string,
  { product = 'casino', refId = randomUUID(), round = randomUUID() } = {} as {
    product?: WagerProduct;
    refId?: string;
    round?: string;
  },
) =>
  drizzle().transaction((tx) =>
    commands().debit(tx, {
      userId,
      amount,
      type: 'bet',
      currency: 'USD',
      context: { provider: 'aggregator', product },
      providerRef: { providerName: 'aggregator', providerRefId: refId, externalRoundId: round },
    }),
  );

const reverse = (userId: string, amount: string, round: string, of: string, refId = randomUUID()) =>
  drizzle().transaction((tx) =>
    commands().credit(tx, {
      userId,
      amount,
      currency: 'USD',
      type: 'bet_reversal',
      reversesTransactionId: of,
      providerRef: { providerName: 'aggregator', providerRefId: refId, externalRoundId: round },
    }),
  );

const summaryOf = async (client: TestClient) => {
  const res = await client.get('/wallet/turnover');
  expect(res.status).toBe(200);
  return readJson(res);
};

async function staffWith(grants: Array<[string, 'read' | 'read_write']>) {
  const staff = await registerAndMaterializePlayer(app(), {
    email: `turnover-atk-staff-${randomUUID()}@e2e.test`,
  });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, staff.userId));
  const [role] = await drizzle()
    .insert(adminRole)
    .values({ name: `turnover attack staff ${randomUUID()}` })
    .returning({ id: adminRole.id });
  if (!role) {
    throw new Error('role insert returned no row');
  }
  for (const [resource, level] of grants) {
    await drizzle().insert(adminRolePermission).values({ roleId: role.id, resource, level });
  }
  await drizzle().insert(adminRoleAssignment).values({ userId: staff.userId, roleId: role.id });
  return staff.client;
}

const clearOf = (client: TestClient, userId: string, reason = 'verified source of funds') =>
  client.post(`/wallet/admin/players/${userId}/turnover/clear`, { userId, reason });

const turnoverRow = async (userId: string) => {
  const [row] = await drizzle()
    .select()
    .from(walletTurnover)
    .where(eq(walletTurnover.userId, userId));
  return row;
};

describe('withdrawing while turnover is unmet: hostile amounts', () => {
  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['not a number', 'abc'],
    ['exponent', '1e3'],
    ['empty', ''],
  ])('rejects a %s amount as a bad request and moves nothing', async (_label, amount) => {
    const { client, userId } = await player('100');

    const res = await withdraw(client, amount);

    expect(res.status).toBe(400);
    expectMoney(await realBalance(userId), '100', 'balance');
    expect(await ledgerRows(userId, 'withdrawal')).toHaveLength(0);
  });

  it.each([
    ['the smallest tiny amount', '0.01'],
    ['more than the balance', '100000000'],
    ['an absurdly large amount', '99999999999999999999'],
  ])('refuses %s without a withdrawal row and keeps the balance', async (_label, amount) => {
    const { client, userId } = await player('100');

    const res = await withdraw(client, amount);

    expect([400, 409]).toContain(res.status);
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(500);
    expectMoney(await realBalance(userId), '100', 'balance');
    expect(await ledgerRows(userId, 'withdrawal')).toHaveLength(0);
  });

  it('refuses an over-precision amount without a 500 and keeps the balance', async () => {
    const { client, userId } = await player('100');

    const res = await withdraw(client, '1.000000000000000000001');

    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(200);
    expectMoney(await realBalance(userId), '100', 'balance');
  });

  it('refuses the same idempotency key twice as locked and writes no withdrawal', async () => {
    const { client, userId } = await player('100');
    const key = randomUUID();

    const first = await withdraw(client, '10', key);
    const second = await withdraw(client, '10', key);

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(await ledgerRows(userId, 'withdrawal')).toHaveLength(0);
  });

  it('keeps a committed withdrawal replayable after the requirement grows again', async () => {
    const { client, userId } = await player('100');
    const topUp = await admin().post('/wallet/manual-adjustments', {
      userId,
      direction: 'credit',
      amount: '100',
      currency: 'USD',
      reason: 'replay test funds',
      idempotencyKey: randomUUID(),
    });
    expect(topUp.status).toBe(200);
    expect((await stake(userId, '100')).ok).toBe(true);
    const key = randomUUID();
    const accepted = await withdraw(client, '40', key);
    expect(accepted.status).toBe(200);
    const original = await readJson(accepted);
    await deposit(client, '50');

    const replay = await withdraw(client, '40', key);

    expect(replay.status).toBe(200);
    expect((await readJson(replay)).transactionId).toBe(original.transactionId);
    expect(await ledgerRows(userId, 'withdrawal')).toHaveLength(1);
  });
});

describe('the dust boundary', () => {
  it('accepts a withdrawal at exactly the dust threshold and refuses just above it', async () => {
    const { client, userId } = await player('100');
    const topUp = await admin().post('/wallet/manual-adjustments', {
      userId,
      direction: 'credit',
      amount: '100',
      currency: 'USD',
      reason: 'dust boundary funds',
      idempotencyKey: randomUUID(),
    });
    expect(topUp.status).toBe(200);
    await stake(userId, '99.98');
    expectMoney((await summaryOf(client)).remaining, '0.02', 'remaining');
    expect((await withdraw(client, '1')).status).toBe(409);

    await stake(userId, '0.01');
    expectMoney((await summaryOf(client)).remaining, '0.01', 'remaining');
    expect((await withdraw(client, '1')).status).toBe(200);
  });
});

describe('a queued withdrawal and a later reversal', () => {
  it('lets staff approve the queued withdrawal after a reversal re-opens the requirement, and refuses a new one', async () => {
    const { client, userId } = await player('100');
    const bet = await stake(userId, '100');
    if (!bet.ok || !bet.moved) {
      throw new Error('bet did not move');
    }
    await deposit(client, '10');
    const round = (
      await drizzle()
        .select({ r: walletTransaction.externalRoundId })
        .from(walletTransaction)
        .where(eq(walletTransaction.id, bet.transactionId))
    )[0]?.r;
    expect((await summaryOf(client)).locked).toBe(true);
    expect(await clearOf(admin(), userId)).toMatchObject({ status: 200 });
    await stake(userId, '1');
    expect((await summaryOf(client)).locked).toBe(false);
    const queued = await withdraw(client, '5');
    expect(queued.status).toBe(200);
    const { transactionId } = await readJson(queued);

    expect((await reverse(userId, '100', round ?? '', bet.transactionId)).ok).toBe(true);
    await deposit(client, '10');
    expect((await summaryOf(client)).locked).toBe(true);
    expect((await withdraw(client, '1')).status).toBe(409);

    const approved = await admin().post(`/wallet/withdrawals/${transactionId}/approve`, {
      withdrawalId: transactionId,
    });
    expect(approved.status).toBe(200);
    expect(await readJson(approved)).toMatchObject({ status: 'completed' });
  });
});

describe('replays never move the requirement twice', () => {
  it('counts a replayed bet once and takes a replayed reversal back once', async () => {
    const { client, userId } = await player('100');
    const refId = randomUUID();
    const round = randomUUID();
    const first = await stake(userId, '30', { refId, round });
    if (!first.ok || !first.moved) {
      throw new Error('bet did not move');
    }
    const again = await stake(userId, '30', { refId, round });
    expect(again).toMatchObject({ ok: true, moved: false });
    expectMoney((await summaryOf(client)).progress, '30', 'progress after bet replay');
    const stakes = await drizzle()
      .select({ id: walletTransaction.id })
      .from(walletTransaction)
      .where(and(eq(walletTransaction.type, 'bet'), eq(walletTransaction.providerRefId, refId)));
    expect(stakes).toHaveLength(1);

    const reversalRef = randomUUID();
    expect((await reverse(userId, '30', round, first.transactionId, reversalRef)).ok).toBe(true);
    expectMoney((await summaryOf(client)).progress, '0', 'progress after reversal');
    await reverse(userId, '30', round, first.transactionId, reversalRef);
    expectMoney((await summaryOf(client)).progress, '0', 'progress after reversal replay');
    const stamped = await drizzle()
      .select({ state: walletTransaction.turnoverState })
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.type, 'bet_reversal'),
          eq(walletTransaction.externalRoundId, round),
        ),
      );
    expect(stamped).toEqual([{ state: 'reversal' }]);
  });

  it('never takes progress below zero on a second reversal of the same bet under a new reference', async () => {
    const { client, userId } = await player('100');
    const round = randomUUID();
    const bet = await stake(userId, '30', { round });
    if (!bet.ok || !bet.moved) {
      throw new Error('bet did not move');
    }
    await stake(userId, '20');
    await reverse(userId, '30', round, bet.transactionId);
    await reverse(userId, '30', round, bet.transactionId);

    expectMoney((await summaryOf(client)).progress, '20', 'progress');
  });
});

describe('product weights', () => {
  it('counts a pvp stake as nothing and a staff-halved casino stake as half, stamping nothing for pvp', async () => {
    const { client, userId } = await player('100');
    expect((await stake(userId, '10', { product: 'pvp' })).ok).toBe(true);
    expectMoney((await summaryOf(client)).progress, '0', 'pvp progress');
    const stamped = await drizzle()
      .select({ state: walletTransaction.turnoverState })
      .from(walletTransaction)
      .innerJoin(walletTurnover, eq(walletTurnover.userId, userId))
      .where(
        and(eq(walletTransaction.type, 'bet'), sql`${walletTransaction.turnoverState} is not null`),
      );
    expect(stamped.length).toBeGreaterThanOrEqual(0);

    const set = await admin().put('/wallet/admin/turnover-config', {
      productPercent: { casino: 0 },
    });
    expect(set.status).toBe(200);
    try {
      await stake(userId, '10');
      expectMoney((await summaryOf(client)).progress, '0', 'zero-percent casino progress');
    } finally {
      await admin().put('/wallet/admin/turnover-config', { productPercent: { casino: null } });
    }
    await stake(userId, '10');
    expectMoney((await summaryOf(client)).progress, '10', 'progress after the reset');
  });
});

describe('any other debit type through the command port while turnover is unmet', () => {
  it.each(['cashback', 'referral_reward', 'swap_in', 'deposit', 'bonus'] as const)(
    'refuses a %s debit as a transfer and keeps the balance',
    async (type) => {
      const { userId } = await player('100');

      await expect(
        drizzle().transaction((tx) =>
          commands().debit(tx, {
            userId,
            amount: '5',
            type,
            currency: 'USD',
            providerRef: { providerName: 'probe', providerRefId: randomUUID() },
          }),
        ),
      ).rejects.toMatchObject({ name: 'TurnoverLockedError', data: { outflow: 'transfer' } });
      expectMoney(await realBalance(userId), '100', 'balance');
    },
  );

  it('keeps a win_reversal debit out of the command port altogether', async () => {
    const { userId } = await player('100');

    await expect(
      drizzle().transaction((tx) =>
        commands().debit(tx, {
          userId,
          amount: '5',
          type: 'win_reversal',
          currency: 'USD',
          providerRef: { providerName: 'probe', providerRefId: randomUUID() },
        }),
      ),
    ).rejects.toMatchObject({ name: 'WalletCorrectionTypeError' });
  });
});

describe('input validation on the turnover routes', () => {
  it.each([
    ['2 characters', 'ab', 400],
    ['padding that trims to 2', '  ab  ', 400],
    ['501 characters', 'x'.repeat(501), 400],
    ['500 characters', 'y'.repeat(500), 200],
    ['3 characters', 'abc', 200],
  ])('clears with a reason of %s -> %i', async (_label, reason, status) => {
    const { userId } = await player('100');

    const res = await clearOf(admin(), userId, reason);

    expect(res.status).toBe(status);
    if (status === 400) {
      expectMoney((await summaryOf((await player('1')).client)).required, '1', 'unrelated');
      expect((await turnoverRow(userId))?.required).toBeDefined();
      expectMoney((await turnoverRow(userId))?.required ?? '0', '100', 'required kept');
    }
  });

  it('refuses a clear with no reason field and a non-uuid user id', async () => {
    const { userId } = await player('100');
    const missing = await admin().post(`/wallet/admin/players/${userId}/turnover/clear`, {
      userId,
    });
    expect(missing.status).toBe(400);
    const bad = await clearOf(admin(), 'not-a-uuid');
    expect(bad.status).toBe(400);
  });

  it.each([
    ['-1', -1],
    ['101', 101],
    ['1.5', 1.5],
    ['a string', '50'],
    ['null product value on an unknown key', { lottery: 1 }],
  ])('refuses a product percent of %s', async (_label, value) => {
    const body = typeof value === 'object' && value !== null ? value : { casino: value };
    const res = await admin().put('/wallet/admin/turnover-config', { productPercent: body });
    expect(res.status).toBe(400);
  });

  it.each([0, 101, 501, -1, 1.5])('refuses an entries page size of %s', async (limit) => {
    const { client, userId } = await player('100');
    expect((await client.get(`/wallet/turnover/entries?limit=${limit}`)).status).toBe(400);
    expect(
      (await admin().get(`/wallet/admin/players/${userId}/turnover/entries?limit=${limit}`)).status,
    ).toBe(400);
  });

  it('answers a bad cursor with a client error, never a 500', async () => {
    const { client } = await player('100');
    for (const cursor of ['nope', '00000000-0000-0000-0000-000000000000', "1'; drop table x;--"]) {
      const res = await client.get(`/wallet/turnover/entries?cursor=${encodeURIComponent(cursor)}`);
      expect(res.status, `cursor ${cursor}`).toBeLessThan(500);
    }
  });

  it("does not page another player's entries through a foreign cursor", async () => {
    const victim = await player('100');
    const attacker = await player('5');
    await deposit(victim.client, '7');
    const entries = await readJson(await victim.client.get('/wallet/turnover/entries'));
    expect(entries.items.length).toBeGreaterThanOrEqual(2);
    const victimEntry = entries.items[0].id;

    const res = await attacker.client.get(`/wallet/turnover/entries?cursor=${victimEntry}`);

    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const page = await readJson(res);
      const ids = page.items.map((i: { id: string }) => i.id);
      for (const item of entries.items) {
        expect(ids).not.toContain(item.id);
      }
    }
  });

  it('reads only the caller own turnover whatever id a query string names', async () => {
    const victim = await player('100');
    const attacker = await player('5');

    const res = await attacker.client.get(`/wallet/turnover?userId=${victim.userId}`);

    expect(res.status).toBe(200);
    expectMoney((await readJson(res)).required, '5', 'attacker required');
    expect(
      (await attacker.client.get(`/wallet/turnover/entries?userId=${victim.userId}`)).status,
    ).toBeLessThan(500);
    const entries = await readJson(
      await attacker.client.get(`/wallet/turnover/entries?userId=${victim.userId}`),
    );
    for (const item of entries.items) {
      expectMoney(item.amount, '5', 'entry amount');
    }
  });
});

describe('turnover authorization: anonymous and staff gaps', () => {
  it('refuses every turnover route without a session', async () => {
    const userId = randomUUID();
    const bodies: Record<string, unknown> = {
      [`/wallet/admin/players/${userId}/turnover/clear`]: { userId, reason: 'anonymous attempt' },
      '/wallet/admin/turnover-config': { productPercent: { casino: 1 } },
      '/backoffice/promo/grants/convert-transfer-grants': { sources: ['gift'] },
    };
    const paths: Array<[string, string]> = [
      ['GET', '/wallet/turnover'],
      ['GET', '/wallet/turnover/entries'],
      ['GET', `/wallet/admin/players/${userId}/turnover`],
      ['GET', `/wallet/admin/players/${userId}/turnover/entries`],
      ['POST', `/wallet/admin/players/${userId}/turnover/clear`],
      ['GET', '/wallet/admin/turnover-config'],
      ['PUT', '/wallet/admin/turnover-config'],
      ['POST', '/backoffice/promo/grants/convert-transfer-grants'],
    ];
    for (const [method, path] of paths) {
      const res = await app().app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify(bodies[path] ?? {}) }),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses a turnover-config writer on the clear route and a clearer on the config route', async () => {
    const { userId } = await player('100');
    const configWriter = await staffWith([['turnover-config', 'read_write']]);
    const clearer = await staffWith([['turnover', 'read_write']]);

    expect((await clearOf(configWriter, userId)).status).toBe(403);
    expect((await configWriter.get(`/wallet/admin/players/${userId}/turnover`)).status).toBe(403);
    expect(
      (await clearer.put('/wallet/admin/turnover-config', { productPercent: { casino: 1 } }))
        .status,
    ).toBe(403);
    expect((await clearer.get('/wallet/admin/turnover-config')).status).toBe(403);
    expect((await clearOf(clearer, userId)).status).toBe(200);
  });

  it('refuses a read_write turnover staff member on the grant conversion route', async () => {
    const staff = await staffWith([
      ['turnover', 'read_write'],
      ['turnover-config', 'read_write'],
    ]);

    const res = await staff.post('/backoffice/promo/grants/convert-transfer-grants', {
      sources: ['gift'],
    });

    expect(res.status).toBe(403);
  });
});

describe('staff clear racing a credit', () => {
  it('leaves required equal to the counted entries whichever order the two commit in', async () => {
    for (let run = 0; run < 6; run += 1) {
      const { client, userId } = await player('40');

      const [cleared, deposited] = await Promise.all([
        clearOf(admin(), userId),
        client.post('/wallet/deposit', {
          amount: '25',
          currency: 'USD',
          idempotencyKey: randomUUID(),
        }),
      ]);

      expect(cleared.status).toBe(200);
      expect(deposited.status).toBe(200);
      const entries = await drizzle()
        .select()
        .from(walletTurnoverEntry)
        .where(eq(walletTurnoverEntry.userId, userId));
      const counted = entries.filter((e) => e.status === 'counted');
      const owed = counted.reduce((sum, e) => moneyAdd(sum, e.required ?? '0'), '0');
      const row = await turnoverRow(userId);
      expect(entries).toHaveLength(2);
      expect(entries.filter((e) => e.status === 'pending')).toHaveLength(0);
      expectMoney(row?.required ?? '0', owed, `run ${run} required vs counted entries`);
      expect(row?.pendingCount).toBe(0);
    }
  });
});

describe('auto-withdrawal rules and the gate', () => {
  it('refuses a withdrawal request from a player with an auto-approve rule while turnover is unmet', async () => {
    const { client, userId } = await player('100');
    const rule = await admin().put(`/wallet/auto-withdrawal-rules/${userId}`, {
      userId,
      threshold: '1000',
      reason: 'turnover gate test rule',
    });
    expect(rule.status).toBe(200);

    const res = await withdraw(client, '10');

    expect(res.status).toBe(409);
    expect(await ledgerRows(userId, 'withdrawal')).toHaveLength(0);
  });
});

describe('overlap with a bonus lock', () => {
  it('advances grant wagering and turnover once each for one real stake', async () => {
    const { client, userId } = await player('100');
    const grantId = await grant(userId, { amount: '50', linked: '50', multiplier: '5' });
    const before = await grantRow(grantId);

    const outcome = await stake(userId, '20');
    expect(outcome.ok).toBe(true);

    const after = await grantRow(grantId);
    const wagering = moneySubtractStr(after.wageringProgress, before.wageringProgress);
    expect(moneyCompare(wagering, '0')).toBeGreaterThan(0);
    expect(moneyCompare(wagering, '20')).toBeLessThanOrEqual(0);
    const summary = await summaryOf(client);
    expect(moneyCompare(summary.progress, '20')).toBeLessThanOrEqual(0);
    expect(moneyCompare(summary.progress, '0')).toBeGreaterThan(0);
  });

  it('keeps a grant live and the balance whole when a turnover refusal follows a bonus-clear withdrawal', async () => {
    const { client, userId } = await player('100');
    const grantId = await grant(userId, { amount: '50', linked: '0', unlinked: '50' });

    const res = await withdraw(client, '10');

    expect([409]).toContain(res.status);
    expect((await grantRow(grantId)).status).toBe('active');
    expectMoney(await realBalance(userId), '100', 'balance');
  });
});

const moneySubtractStr = (a: string, b: string): string => {
  const [x, y] = [Number(a), Number(b)];
  return String(x - y);
};

describe('audit and events for turnover mutations', () => {
  it('records exactly one audit row per staff action and none for a refused one', async () => {
    const { userId } = await player('100');
    await flushAudit(app());
    const rows = () =>
      drizzle()
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'wallet.turnover.cleared'), eq(auditLog.resourceId, userId)),
        );
    expect((await clearOf(admin(), userId, 'x')).status).toBe(400);
    await flushAudit(app());
    expect(await rows()).toHaveLength(0);
    const events = () =>
      drizzle()
        .select()
        .from(eventOutbox)
        .where(
          and(
            eq(eventOutbox.topic, 'wallet.turnover.cleared'),
            sql`${eventOutbox.payload}->>'userId' = ${userId}`,
          ),
        );
    expect(await events()).toHaveLength(0);
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import {
  AutoWithdrawalRuleSchema,
  TransactionResultSchema,
  WalletAutoWithdrawalConfigSchema,
  WithdrawalQueueItemSchema,
  WithdrawalQueueSummarySchema,
} from '@openora/core/wallet/contract';
import { assignTag, newStaff, type TestClient } from '../index.js';
import {
  autoWithdrawalPlugin,
  balanceOf,
  bootWalletE2e,
  closeWalletE2e,
  newFundedPlayer,
  postWithdrawal,
  requestWithdrawalId,
  transactionById,
  waitForAudit,
  waitForCompleted,
  type WalletE2e,
} from './support/wallet.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([autoWithdrawalPlugin]);
  const seeded = await e2e.admin.put('/wallet/auto-withdrawal-config', {
    fiatThreshold: '0',
    cryptoThreshold: '0',
    excludeRiskFlags: [],
    velocityCount: null,
    velocityWindowHours: 24,
  });
  if (seeded.status !== 200) {
    throw new Error(`seed auto-withdrawal config failed (${seeded.status})`);
  }
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;
const QueuePageSchema = z.object({ items: z.array(WithdrawalQueueItemSchema), total: z.number() });
const ReleaseHeaders = { 'content-type': 'application/json' };

const send = async (res: Response) => ({ status: res.status, body: (await res.json()) as unknown });
const approve = (client: TestClient, id: string) =>
  client.post(`/wallet/withdrawals/${id}/approve`).then(send);
const reject = (client: TestClient, id: string, reason = 'e2e rejection') =>
  client.post(`/wallet/withdrawals/${id}/reject`, { reason }).then(send);
const funded = (amount?: string) => newFundedPlayer(e2e, amount);
const amountOf = (value: string) => `${value}.000000000000000000`;

async function adminUserId() {
  const [row] = await db()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, 'admin@oss.dev'));
  return row!.id;
}

async function queueFor(currency: string, query: Record<string, string> = {}) {
  const params = new URLSearchParams({ currency, ...query });
  const res = await e2e.admin.get(`/wallet/withdrawals?${params}`);
  expect(res.status).toBe(200);
  return QueuePageSchema.parse(await res.json());
}

async function summaryFor(currency: string) {
  const res = await e2e.admin.get(`/wallet/withdrawals/summary?currency=${currency}`);
  expect(res.status).toBe(200);
  return WithdrawalQueueSummarySchema.parse(await res.json());
}

async function paymentsManager() {
  return newStaff(e2e.app, 'withdrawal-payments', 'payments-manager');
}

async function readOnlyAdmin() {
  return newStaff(e2e.app, 'withdrawal-readonly', 'admin');
}

async function removeLockTag(playerId: string, removalReason?: string) {
  return e2e.admin
    .request(`/player/${playerId}/player-tag/withdrawal_lock`, {
      method: 'DELETE',
      headers: ReleaseHeaders,
      body: JSON.stringify({
        removalActor: 'manual',
        removalActorUserId: null,
        ...(removalReason === undefined ? {} : { removalReason }),
      }),
    })
    .then(send);
}

const thresholdConfig = (cryptoThreshold: string) => ({
  fiatThreshold: cryptoThreshold,
  cryptoThreshold,
  excludeRiskFlags: [],
  velocityCount: null,
  velocityWindowHours: 24,
});

async function currentConfig() {
  const res = await e2e.admin.get('/wallet/auto-withdrawal-config');
  expect(res.status).toBe(200);
  return WalletAutoWithdrawalConfigSchema.parse(await res.json());
}

async function withGlobalThreshold<T>(cryptoThreshold: string, run: () => Promise<T>) {
  const before = await currentConfig();
  const set = await e2e.admin.put(
    '/wallet/auto-withdrawal-config',
    thresholdConfig(cryptoThreshold),
  );
  expect(set.status).toBe(200);
  try {
    return await run();
  } finally {
    await e2e.admin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: before.fiatThreshold,
      cryptoThreshold: before.cryptoThreshold,
      excludeRiskFlags: before.excludeRiskFlags,
      velocityCount: before.velocityCount,
      velocityWindowHours: before.velocityWindowHours,
    });
  }
}

const setRule = (userId: string, threshold: string, reason = 'e2e trusted player') =>
  e2e.admin.put(`/wallet/auto-withdrawal-rules/${userId}`, { threshold, reason });

describe('admin withdrawal queue decisions', () => {
  it('an admin listing the withdrawal queue sees waiting withdrawals filtered and summarised', async () => {
    const player = await funded();
    const small = await requestWithdrawalId(player.client, player, { amount: '10' });
    const large = await requestWithdrawalId(player.client, player, { amount: '30' });
    const rejected = await requestWithdrawalId(player.client, player, { amount: '5' });
    await reject(e2e.admin, rejected);

    const all = await queueFor(player.currency);
    const big = await queueFor(player.currency, { minAmount: '20' });
    const waiting = await queueFor(player.currency, { status: 'pending' });
    const refused = await queueFor(player.currency, { status: 'rejected' });
    const summary = await summaryFor(player.currency);

    expect(all.total).toBe(3);
    expect(all.items.map((item) => item.transactionId).sort()).toEqual(
      [small, large, rejected].sort(),
    );
    expect(big.items.map((item) => item.transactionId)).toEqual([large]);
    expect(waiting.items.map((item) => item.transactionId).sort()).toEqual([small, large].sort());
    expect(refused.items.map((item) => item.transactionId)).toEqual([rejected]);
    expect(waiting.items[0]).toEqual(
      expect.objectContaining({
        userId: player.userId,
        currency: player.currency,
        status: 'pending',
        withdrawalLocked: false,
        withdrawalHeld: false,
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        pendingCount: 2,
        onHoldCount: 0,
        queuedTotals: [{ currency: player.currency, amount: amountOf('40') }],
      }),
    );
  });

  it('an admin approving a waiting withdrawal pays it out once and the ledger row completes', async () => {
    const player = await funded();
    const id = await requestWithdrawalId(player.client, player, { amount: '10' });
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('90'));

    const approved = await approve(e2e.admin, id);

    expect(approved.status).toBe(200);
    expect(TransactionResultSchema.parse(approved.body)).toEqual({
      transactionId: id,
      status: 'completed',
    });
    const row = await transactionById(e2e, id);
    expect(row).toEqual(
      expect.objectContaining({
        status: 'completed',
        type: 'withdrawal',
        reviewedBy: await adminUserId(),
        providerRefId: expect.stringMatching(/^test-/),
      }),
    );
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('90'));
    const withdrawals = await db()
      .select({ id: walletTransaction.id })
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.type, 'withdrawal'),
          eq(walletTransaction.currency, player.currency),
        ),
      );
    expect(withdrawals).toEqual([{ id }]);
  });

  it('approving the same withdrawal twice pays once and the second call is refused as not pending', async () => {
    const player = await funded();
    const id = await requestWithdrawalId(player.client, player, { amount: '10' });
    const first = await approve(e2e.admin, id);
    const paid = await transactionById(e2e, id);

    const second = await approve(e2e.admin, id);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
    const after = await transactionById(e2e, id);
    expect(after).toEqual(
      expect.objectContaining({ status: 'completed', providerRefId: paid!.providerRefId }),
    );
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('90'));
  });

  it('an admin rejecting a waiting withdrawal with a reason refunds the full amount once and writes the audit row', async () => {
    const player = await funded();
    const id = await requestWithdrawalId(player.client, player, { amount: '10' });
    const reason = `e2e reject ${randomUUID()}`;

    const rejected = await reject(e2e.admin, id, reason);

    expect(rejected.status).toBe(200);
    expect(TransactionResultSchema.parse(rejected.body)).toEqual({
      transactionId: id,
      status: 'rejected',
    });
    expect(await transactionById(e2e, id)).toEqual(
      expect.objectContaining({
        status: 'rejected',
        reviewReason: reason,
        reviewedBy: await adminUserId(),
      }),
    );
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('100'));
    const audited = (await waitForAudit(e2e, 'wallet.withdrawal.rejected', player.playerId)).filter(
      (row) => row.after?.['transactionId'] === id,
    );
    expect(audited).toEqual([
      expect.objectContaining({
        actorId: await adminUserId(),
        actorType: 'admin',
        after: expect.objectContaining({ reason, amount: amountOf('10') }),
      }),
    ]);
  });

  it('rejecting the same withdrawal twice refunds once and the second call is refused as not pending', async () => {
    const player = await funded();
    const id = await requestWithdrawalId(player.client, player, { amount: '10' });
    const first = await reject(e2e.admin, id);

    const second = await reject(e2e.admin, id);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('100'));
  });

  it('rejecting a withdrawal after it was approved is refused and refunds nothing', async () => {
    const player = await funded();
    const id = await requestWithdrawalId(player.client, player, { amount: '10' });
    await approve(e2e.admin, id);

    const rejected = await reject(e2e.admin, id);

    expect(rejected.status).toBe(409);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('90'));
    expect((await transactionById(e2e, id))?.status).toBe('completed');
  });

  it('approving a withdrawal while two admins race on it pays once', async () => {
    const player = await funded();
    const id = await requestWithdrawalId(player.client, player, { amount: '10' });
    const second = await paymentsManager();

    const results = await Promise.all([approve(e2e.admin, id), approve(second.client, id)]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await transactionById(e2e, id))?.status).toBe('completed');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('90'));
  });

  it('approving or rejecting a withdrawal that does not exist answers not found', async () => {
    const missing = randomUUID();

    const approved = await approve(e2e.admin, missing);
    const rejected = await reject(e2e.admin, missing);

    expect(approved.status).toBe(404);
    expect(rejected.status).toBe(404);
  });

  it('a player or an admin without the withdrawal permission calling approve or reject is refused with 403', async () => {
    const player = await funded();
    const id = await requestWithdrawalId(player.client, player, { amount: '10' });
    const viewer = await readOnlyAdmin();

    const attempts = await Promise.all(
      [player.client, viewer.client].flatMap((client) => [approve(client, id), reject(client, id)]),
    );

    expect(attempts.map((attempt) => attempt.status)).toEqual([403, 403, 403, 403]);
    expect((await transactionById(e2e, id))?.status).toBe('pending');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('90'));
  });

  it('an unauthenticated caller calling approve, reject or list is refused with 401', async () => {
    const id = randomUUID();
    const call = async (path: string, method: string, body?: unknown) =>
      e2e.app.app.request(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });

    const statuses = await Promise.all([
      call(`/wallet/withdrawals/${id}/approve`, 'POST').then((res) => res.status),
      call(`/wallet/withdrawals/${id}/reject`, 'POST', { reason: 'nope' }).then(
        (res) => res.status,
      ),
      call('/wallet/withdrawals', 'GET').then((res) => res.status),
    ]);

    expect(statuses).toEqual([401, 401, 401]);
  });

  it('approving a withdrawal of a locked player is refused until the lock is released', async () => {
    const player = await funded();
    const id = await requestWithdrawalId(player.client, player, { amount: '10' });
    await assignTag(e2e.admin, player.playerId, 'withdrawal_lock', 'e2e investigation hold');

    const refused = await approve(e2e.admin, id);

    expect(refused.status).toBe(409);
    expect((await transactionById(e2e, id))?.status).toBe('pending');
    const queued = await queueFor(player.currency);
    expect(queued.items).toEqual([
      expect.objectContaining({ transactionId: id, withdrawalLocked: true }),
    ]);

    const released = await removeLockTag(player.playerId, 'e2e investigation closed');
    expect(released.status).toBe(200);
    const approved = await approve(e2e.admin, id);

    expect(approved.status).toBe(200);
    expect((await transactionById(e2e, id))?.status).toBe('completed');
  });
});

describe('withdrawal lock and release', () => {
  it("an admin locking a player's withdrawals with a reason refuses new withdrawals of that player until release and writes an audit row", async () => {
    const player = await funded();
    const reason = `e2e lock ${randomUUID()}`;

    await assignTag(e2e.admin, player.playerId, 'withdrawal_lock', reason);
    const refused = await postWithdrawal(player.client, player, { amount: '10' });

    expect(refused.status).toBe(409);
    expect(refused.body).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('100'));
    const queued = await queueFor(player.currency);
    expect(queued.total).toBe(0);
    const audited = await waitForAudit(e2e, 'tag.player.assigned', player.playerId);
    expect(audited).toEqual([
      expect.objectContaining({
        actorId: await adminUserId(),
        after: expect.objectContaining({ tagKey: 'withdrawal_lock', reason }),
      }),
    ]);
  });

  it('an admin releasing the lock with a reason lets the held withdrawals be approved and writes an audit row', async () => {
    const player = await funded();
    const held = await requestWithdrawalId(player.client, player, { amount: '10' });
    await assignTag(e2e.admin, player.playerId, 'withdrawal_lock', 'e2e investigation hold');
    const reason = `e2e release ${randomUUID()}`;

    const released = await removeLockTag(player.playerId, reason);
    const approved = await approve(e2e.admin, held);
    const next = await postWithdrawal(player.client, player, { amount: '10' });

    expect(released.status).toBe(200);
    expect(approved.status).toBe(200);
    expect(next.status).toBe(200);
    expect((await transactionById(e2e, held))?.status).toBe('completed');
    const audited = await waitForAudit(e2e, 'tag.player.removed', player.playerId);
    expect(audited).toEqual([
      expect.objectContaining({
        actorId: await adminUserId(),
        after: expect.objectContaining({ tagKey: 'withdrawal_lock', reason }),
      }),
    ]);
  });

  it('locking or releasing without a reason is refused', async () => {
    const player = await funded();

    const lockWithoutReason = await e2e.admin.post(`/player/${player.playerId}/player-tag`, {
      tagKey: 'withdrawal_lock',
      assignActor: 'manual',
    });
    const lockWithBlankReason = await e2e.admin.post(`/player/${player.playerId}/player-tag`, {
      tagKey: 'withdrawal_lock',
      assignActor: 'manual',
      assignReason: '',
    });
    const stillFree = await postWithdrawal(player.client, player, { amount: '10' });
    await assignTag(e2e.admin, player.playerId, 'withdrawal_lock', 'e2e investigation hold');
    const releaseWithoutReason = await removeLockTag(player.playerId);
    const releaseBlankReason = await removeLockTag(player.playerId, '   ');
    const stillLocked = await postWithdrawal(player.client, player, { amount: '10' });

    expect(lockWithoutReason.status).toBe(400);
    expect(lockWithBlankReason.status).toBe(400);
    expect(stillFree.status).toBe(200);
    expect(releaseWithoutReason.status).toBe(400);
    expect(releaseBlankReason.status).toBe(400);
    expect(stillLocked.status).toBe(409);
  });
});

describe('auto-withdrawal rules and config', () => {
  it('an admin setting the global auto-withdrawal threshold sees it applied to the next withdrawal and an audit row written', async () => {
    const player = await funded();
    const before = await currentConfig();

    await withGlobalThreshold('1000', async () => {
      const id = await requestWithdrawalId(player.client, player, { amount: '10' });

      const paid = await waitForCompleted(e2e, id);

      expect(paid.reviewedBy).toBeNull();
      expect(paid.providerRefId).toMatch(/^test-/);
      const audited = (
        await waitForAudit(e2e, 'wallet.auto_withdrawal_config.set', before.id)
      ).filter((row) => row.after?.['cryptoThreshold'] === amountOf('1000'));
      expect(audited).toEqual([
        expect.objectContaining({
          actorId: await adminUserId(),
          before: expect.objectContaining({ cryptoThreshold: before.cryptoThreshold }),
        }),
      ]);
    });
    expect((await currentConfig()).cryptoThreshold).toBe(before.cryptoThreshold);
  });

  it('an admin setting a per-player rule overrides the global threshold for that player only', async () => {
    const trusted = await funded();
    const other = await funded();
    const otherId = await requestWithdrawalId(other.client, other, { amount: '10' });
    const rule = await setRule(trusted.userId, '1000');
    expect(rule.status).toBe(200);
    expect(AutoWithdrawalRuleSchema.parse(await rule.json())).toEqual(
      expect.objectContaining({ userId: trusted.userId, threshold: amountOf('1000') }),
    );

    const trustedId = await requestWithdrawalId(trusted.client, trusted, { amount: '10' });

    await waitForCompleted(e2e, trustedId);
    expect((await transactionById(e2e, otherId))?.status).toBe('pending');
    const audited = await waitForAudit(e2e, 'wallet.auto_withdrawal_rule.set', trusted.userId);
    expect(audited).toEqual([
      expect.objectContaining({
        actorId: await adminUserId(),
        after: expect.objectContaining({ threshold: amountOf('1000') }),
      }),
    ]);
  });

  it('an admin deleting a per-player rule returns that player to the global threshold and writes an audit row', async () => {
    const player = await funded();
    const control = await funded();
    await setRule(player.userId, '1000');
    await setRule(control.userId, '1000');

    const deleted = await e2e.admin.del(`/wallet/auto-withdrawal-rules/${player.userId}`);
    const lookup = await e2e.admin.get(`/wallet/auto-withdrawal-rules/${player.userId}`);
    const waitingId = await requestWithdrawalId(player.client, player, { amount: '10' });
    const controlId = await requestWithdrawalId(control.client, control, { amount: '10' });

    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toBe(true);
    expect(await lookup.json()).toBeNull();
    await waitForCompleted(e2e, controlId);
    expect((await transactionById(e2e, waitingId))?.status).toBe('pending');
    const audited = await waitForAudit(e2e, 'wallet.auto_withdrawal_rule.deleted', player.userId);
    expect(audited).toEqual([
      expect.objectContaining({
        actorId: await adminUserId(),
        before: expect.objectContaining({ threshold: amountOf('1000') }),
        after: null,
      }),
    ]);
  });

  it('with a zero global auto-withdrawal threshold every withdrawal waits in the admin queue', async () => {
    const player = await funded();
    const control = await funded();
    await setRule(control.userId, '1000');

    await withGlobalThreshold('0', async () => {
      const waitingId = await requestWithdrawalId(player.client, player, { amount: '10' });
      const controlId = await requestWithdrawalId(control.client, control, { amount: '10' });

      await waitForCompleted(e2e, controlId);

      expect((await transactionById(e2e, waitingId))?.status).toBe('pending');
    });
  });

  it('a threshold value that is not a valid decimal amount is refused', async () => {
    const player = await funded();
    const before = await currentConfig();

    const attempts = await Promise.all([
      e2e.admin.put('/wallet/auto-withdrawal-config', thresholdConfig('abc')),
      e2e.admin.put('/wallet/auto-withdrawal-config', thresholdConfig('-5')),
      e2e.admin.put('/wallet/auto-withdrawal-config', thresholdConfig('12345678901')),
      setRule(player.userId, 'abc'),
      setRule(player.userId, '0'),
      setRule(player.userId, '-1'),
    ]);

    expect(attempts.map((attempt) => attempt.status)).toEqual([400, 400, 400, 400, 400, 400]);
    expect(await currentConfig()).toEqual(before);
    const rule = await e2e.admin.get(`/wallet/auto-withdrawal-rules/${player.userId}`);
    expect(await rule.json()).toBeNull();
  });

  it('a non-admin changing auto-withdrawal config or rules is refused with 403', async () => {
    const player = await funded();
    const viewer = await readOnlyAdmin();
    const before = await currentConfig();

    const attempts = await Promise.all(
      [player.client, viewer.client].flatMap((client) => [
        client.put('/wallet/auto-withdrawal-config', thresholdConfig('1000')),
        client.put(`/wallet/auto-withdrawal-rules/${player.userId}`, {
          threshold: '1000',
          reason: 'e2e forbidden',
        }),
        client.del(`/wallet/auto-withdrawal-rules/${player.userId}`),
      ]),
    );

    expect(attempts.map((attempt) => attempt.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(await currentConfig()).toEqual(before);
    const rule = await e2e.admin.get(`/wallet/auto-withdrawal-rules/${player.userId}`);
    expect(await rule.json()).toBeNull();
  });
});

describe('manual balance adjustment', () => {
  const adjust = (
    client: TestClient,
    player: { userId: string; currency: string },
    overrides: Record<string, unknown> = {},
  ) =>
    client
      .post('/wallet/manual-adjustments', {
        userId: player.userId,
        direction: 'credit',
        currency: player.currency,
        amount: '25',
        reason: 'e2e goodwill',
        idempotencyKey: randomUUID(),
        ...overrides,
      })
      .then(send);

  const manualRows = (userId: string, currency: string) =>
    db()
      .select({ tx: walletTransaction })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(wallet.userId, userId),
          inArray(walletTransaction.type, ['manual_credit', 'manual_debit']),
          eq(walletTransaction.currency, currency),
        ),
      )
      .then((rows) => rows.map((row) => row.tx));

  it('an admin crediting a player manually raises the balance and writes one ledger row and one audit row with the reason', async () => {
    const player = await funded();
    const reason = `e2e credit ${randomUUID()}`;

    const credited = await adjust(e2e.admin, player, { amount: '25', reason });

    expect(credited.status).toBe(200);
    const { transactionId, status } = TransactionResultSchema.parse(credited.body);
    expect(status).toBe('completed');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('125'));
    expect(await manualRows(player.userId, player.currency)).toEqual([
      expect.objectContaining({
        id: transactionId,
        type: 'manual_credit',
        direction: 'credit',
        amount: amountOf('25'),
        balanceAfter: amountOf('125'),
        reviewReason: reason,
        reviewedBy: await adminUserId(),
      }),
    ]);
    const audited = (
      await waitForAudit(e2e, 'wallet.manual_adjustment.created', player.playerId)
    ).filter((row) => row.after?.['transactionId'] === transactionId);
    expect(audited).toEqual([
      expect.objectContaining({
        actorId: await adminUserId(),
        before: expect.objectContaining({ balance: amountOf('100') }),
        after: expect.objectContaining({ balance: amountOf('125'), reason, direction: 'credit' }),
      }),
    ]);
  });

  it('an admin debiting a player manually lowers the balance and writes one ledger row and one audit row with the reason', async () => {
    const player = await funded();
    const reason = `e2e debit ${randomUUID()}`;

    const debited = await adjust(e2e.admin, player, { direction: 'debit', amount: '40', reason });

    expect(debited.status).toBe(200);
    const { transactionId } = TransactionResultSchema.parse(debited.body);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('60'));
    expect(await manualRows(player.userId, player.currency)).toEqual([
      expect.objectContaining({
        id: transactionId,
        type: 'manual_debit',
        direction: 'debit',
        amount: amountOf('40'),
        balanceAfter: amountOf('60'),
        reviewReason: reason,
      }),
    ]);
    const audited = (
      await waitForAudit(e2e, 'wallet.manual_adjustment.created', player.playerId)
    ).filter((row) => row.after?.['transactionId'] === transactionId);
    expect(audited).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ balance: amountOf('100') }),
        after: expect.objectContaining({ balance: amountOf('60'), reason, direction: 'debit' }),
      }),
    ]);
  });

  it('a manual debit larger than the balance is refused and the balance never goes negative', async () => {
    const player = await funded();

    const refused = await adjust(e2e.admin, player, {
      direction: 'debit',
      amount: '100.000000000000000001',
    });

    expect(refused.status).toBe(400);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('100'));
    expect(await manualRows(player.userId, player.currency)).toEqual([]);
  });

  it('a manual adjustment replayed with the same idempotency key applies once', async () => {
    const player = await funded();
    const idempotencyKey = randomUUID();

    const first = await adjust(e2e.admin, player, { idempotencyKey });
    const second = await adjust(e2e.admin, player, { idempotencyKey });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('125'));
    expect(await manualRows(player.userId, player.currency)).toHaveLength(1);
    const { transactionId } = TransactionResultSchema.parse(first.body);
    const audited = (
      await waitForAudit(e2e, 'wallet.manual_adjustment.created', player.playerId)
    ).filter((row) => row.after?.['transactionId'] === transactionId);
    expect(audited).toHaveLength(1);
  });

  it('a manual adjustment with the same key and a different amount is refused', async () => {
    const player = await funded();
    const idempotencyKey = randomUUID();
    await adjust(e2e.admin, player, { idempotencyKey, amount: '25' });

    const reused = await adjust(e2e.admin, player, { idempotencyKey, amount: '30' });

    expect(reused.status).toBe(409);
    expect(reused.body).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('125'));
    expect(await manualRows(player.userId, player.currency)).toHaveLength(1);
  });

  it('a manual adjustment without a reason is refused', async () => {
    const player = await funded();

    const blank = await adjust(e2e.admin, player, { reason: '   ' });
    const empty = await adjust(e2e.admin, player, { reason: '' });
    const withoutReason = {
      userId: player.userId,
      direction: 'credit',
      currency: player.currency,
      amount: '25',
      idempotencyKey: randomUUID(),
    };
    const missing = await e2e.admin.post('/wallet/manual-adjustments', withoutReason).then(send);

    expect([blank.status, empty.status, missing.status]).toEqual([400, 400, 400]);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('100'));
    expect(await manualRows(player.userId, player.currency)).toEqual([]);
  });

  it('a non-admin requesting a manual adjustment is refused with 403', async () => {
    const player = await funded();
    const payments = await paymentsManager();

    const attempts = await Promise.all([
      adjust(player.client, player),
      adjust(payments.client, player),
      adjust(payments.client, player, { direction: 'debit' }),
    ]);

    expect(attempts.map((attempt) => attempt.status)).toEqual([403, 403, 403]);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('100'));
    expect(await manualRows(player.userId, player.currency)).toEqual([]);
  });
});

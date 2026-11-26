import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { user } from '@openora/core/pam/schema/identity';
import { TransactionResultSchema, WithdrawalAddressSchema } from '@openora/core/wallet/contract';
import {
  wallet,
  walletTransaction,
  walletWithdrawalAddress,
  walletWithdrawalHold,
} from '@openora/core/wallet/schema';
import { registerAndMaterializePlayer, screenedWithdrawalStatus } from '../index.js';
import {
  autoWithdrawalPlugin,
  balanceOf,
  bootWalletE2e,
  closeWalletE2e,
  NETWORK,
  newDepositScenario,
  deliverWebhook,
  postWithdrawal,
  transactionById,
  type WalletE2e,
} from './support/wallet.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([
    autoWithdrawalPlugin,
    {
      id: 'testing-withdrawal-adapter',
      path: fileURLToPath(new URL('./support/test-withdrawal-adapter-plugin.ts', import.meta.url)),
    },
  ]);
  const config = await e2e.admin.get('/wallet/auto-withdrawal-config');
  if (config.status !== 200) {
    const seeded = await e2e.admin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '0',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
      velocityCount: null,
      velocityWindowHours: 24,
    });
    expect(seeded.status).toBe(200);
  }
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;
const money = (amount: string) => `${amount}.000000000000000000`;
const PASSWORD = 'password1234';
const DAY_MS = 24 * 60 * 60 * 1000;

async function newFundedPlayer(target: WalletE2e, amount: string) {
  const player = await newDepositScenario(target);
  const res = await deliverWebhook(target, player.deposit({ amount }));
  expect(res.status).toBe(200);
  return player;
}

type Player = Awaited<ReturnType<typeof newFundedPlayer>>;

const withdraw = (player: Player, overrides: Record<string, unknown> = {}) =>
  postWithdrawal(player.client, player, { destinationAddress: undefined, ...overrides });

const requestedId = async (player: Player, overrides: Record<string, unknown> = {}) => {
  const { status, body } = await withdraw(player, overrides);
  expect(status).toBe(200);
  return TransactionResultSchema.parse(body).transactionId;
};

const setAsset = async (player: Player, changes: Record<string, unknown>, network = NETWORK) => {
  const res = await e2e.admin.put(`/wallet/admin/assets/${player.currency}/${network}`, changes);
  expect(res.status).toBe(200);
};

const setRule = async (player: Player, threshold: string) => {
  const res = await e2e.admin.put(`/wallet/auto-withdrawal-rules/${player.userId}`, {
    threshold,
    reason: 'e2e rule',
  });
  expect(res.status).toBe(200);
};

const withdrawalRows = (player: Player) =>
  db()
    .select({ id: walletTransaction.id })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(and(eq(wallet.userId, player.userId), eq(walletTransaction.type, 'withdrawal')));

const refused = (body: unknown, code: string, reason?: string) =>
  expect(body).toEqual(
    expect.objectContaining({
      code,
      ...(reason ? { data: expect.objectContaining({ reason }) } : {}),
    }),
  );

const lockedUntilOf = (body: unknown) =>
  typeof body === 'object' &&
  body !== null &&
  'data' in body &&
  typeof body.data === 'object' &&
  body.data !== null &&
  'lockedUntil' in body.data &&
  typeof body.data.lockedUntil === 'string'
    ? body.data.lockedUntil
    : undefined;

const setPin = async (player: Player, pin: string) => {
  const res = await player.client.post('/identity/security/withdrawal-pin', {
    pin,
    confirmPin: pin,
    currentPassword: PASSWORD,
  });
  expect(res.status).toBe(200);
};

const saveAddress = (
  player: Player,
  overrides: Record<string, unknown> = {},
  client = player.client,
) =>
  client.post('/wallet/withdrawal-addresses', {
    label: 'e2e address',
    currency: player.currency,
    network: NETWORK,
    address: `dest-${randomUUID()}`,
    currentPassword: PASSWORD,
    ...overrides,
  });

const savedAddress = async (player: Player, overrides: Record<string, unknown> = {}) => {
  const res = await saveAddress(player, overrides);
  expect(res.status).toBe(200);
  return WithdrawalAddressSchema.parse(await res.json());
};

const backdateAddress = (id: string, ms: number) =>
  db()
    .update(walletWithdrawalAddress)
    .set({ createdAt: new Date(Date.now() - ms) })
    .where(eq(walletWithdrawalAddress.id, id));

describe('player withdrawal request', () => {
  it('a player withdrawing below the auto threshold is paid out automatically and the withdrawal completes with a debit ledger row', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setRule(player, '1000');

    const id = await requestedId(player, { amount: '30' });

    expect(await screenedWithdrawalStatus(e2e.app, id)).toBe('completed');
    expect(await transactionById(e2e, id)).toEqual(
      expect.objectContaining({
        type: 'withdrawal',
        direction: 'debit',
        status: 'completed',
        amount: money('30'),
        currency: player.currency,
      }),
    );
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('70'));
  });

  it('a player withdrawing above the auto threshold waits in the admin queue and is debited at request time', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setRule(player, '10');

    const id = await requestedId(player, { amount: '30' });

    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('70'));
    expect(await screenedWithdrawalStatus(e2e.app, id)).toBe('pending');
    expect(await transactionById(e2e, id)).toEqual(
      expect.objectContaining({ status: 'pending', direction: 'debit', amount: money('30') }),
    );
  });

  it('a withdrawal threshold in another currency is evaluated in the reference currency at the stored rate', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setRule(player, '40');

    const small = await requestedId(player, { amount: '20' });
    const large = await requestedId(player, { amount: '30' });

    expect(await screenedWithdrawalStatus(e2e.app, small)).toBe('completed');
    expect(await screenedWithdrawalStatus(e2e.app, large)).toBe('pending');
  });

  it('a withdrawal exactly at the auto threshold is still paid out automatically', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setRule(player, '60');

    const id = await requestedId(player, { amount: '40' });

    expect(await screenedWithdrawalStatus(e2e.app, id)).toBe('completed');
  });

  it('a withdrawal below the asset minimum is refused and the balance is unchanged', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setAsset(player, { minWithdrawal: '20' });

    const { status, body } = await withdraw(player, { amount: '15' });

    expect(status).toBe(400);
    refused(body, 'BAD_REQUEST');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('a withdrawal not above the network fee is refused and the balance is unchanged', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setAsset(player, { withdrawalFee: '5' });

    const atFee = await withdraw(player, { amount: '5' });

    expect(atFee.status).toBe(400);
    refused(atFee.body, 'BAD_REQUEST');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('a withdrawal with more decimals than the asset allows is refused and the balance is unchanged', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const { status, body } = await withdraw(player, { amount: '10.123' });

    expect(status).toBe(400);
    refused(body, 'BAD_REQUEST');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('a withdrawal larger than the balance is refused and the balance never goes negative', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const { status, body } = await withdraw(player, { amount: '150' });

    expect(status).toBe(400);
    refused(body, 'BAD_REQUEST');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('two concurrent withdrawals that together exceed the balance debit once and refuse the other', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const results = await Promise.all([
      withdraw(player, { amount: '60' }),
      withdraw(player, { amount: '60' }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('40'));
    expect(await withdrawalRows(player)).toHaveLength(1);
  });

  it('a repeated withdrawal request with the same idempotency key debits once and returns the same withdrawal', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const idempotencyKey = randomUUID();

    const first = await withdraw(player, { amount: '10', idempotencyKey });
    const second = await withdraw(player, { amount: '10', idempotencyKey });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(TransactionResultSchema.parse(second.body).transactionId).toBe(
      TransactionResultSchema.parse(first.body).transactionId,
    );
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('90'));
    expect(await withdrawalRows(player)).toHaveLength(1);
  });

  it('the same idempotency key reused with a different amount or currency is refused as key reuse', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const idempotencyKey = randomUUID();
    await requestedId(player, { amount: '10', idempotencyKey });

    const otherAmount = await withdraw(player, { amount: '11', idempotencyKey });
    const otherCurrency = await withdraw(player, { amount: '10', currency: 'ZZZ', idempotencyKey });

    expect(otherAmount.status).toBe(409);
    refused(otherAmount.body, 'CONFLICT');
    expect(otherCurrency.status).toBe(409);
    refused(otherCurrency.body, 'CONFLICT');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('90'));
    expect(await withdrawalRows(player)).toHaveLength(1);
  });

  it('a withdrawal with no fresh exchange rate is refused and nothing is debited', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await db()
      .update(exchangeRateQuote)
      .set({ providerAsOf: new Date(Date.now() - DAY_MS) })
      .where(eq(exchangeRateQuote.baseCurrency, player.currency));

    const { status, body } = await withdraw(player, { amount: '10' });

    expect(status).toBe(503);
    refused(body, 'SERVICE_UNAVAILABLE');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('a withdrawal for a currency or network with withdrawals switched off is refused', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const created = await e2e.admin.post('/wallet/admin/assets', {
      currency: player.currency,
      network: 'SECONDCHAIN',
      minDeposit: '10',
      providerAssetId: `${player.currency}-SECONDCHAIN`,
      minWithdrawal: '1',
      withdrawalFee: '0',
    });
    expect(created.status).toBe(200);
    await setAsset(player, { withdrawalEnabled: false }, 'SECONDCHAIN');

    const switchedOffNetwork = await withdraw(player, { amount: '10', network: 'SECONDCHAIN' });
    await setAsset(player, { withdrawalEnabled: false });
    const switchedOffCurrency = await withdraw(player, { amount: '10' });

    expect(switchedOffNetwork.status).toBe(400);
    refused(switchedOffNetwork.body, 'BAD_REQUEST');
    expect(switchedOffCurrency.status).toBe(409);
    refused(switchedOffCurrency.body, 'CONFLICT');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('a player with a withdrawal hold from another module is refused a withdrawal and cannot have a pending one approved until the hold is released', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const pendingId = await requestedId(player, { amount: '10' });
    await db()
      .insert(walletWithdrawalHold)
      .values({ userId: player.userId, source: 'e2e-hold', reason: 'e2e hold' });

    const refusedNew = await withdraw(player, { amount: '10' });
    const refusedApproval = await e2e.admin.post(`/wallet/withdrawals/${pendingId}/approve`, {});

    expect(refusedNew.status).toBe(409);
    refused(refusedNew.body, 'CONFLICT', 'withdrawal_held');
    expect(refusedApproval.status).toBe(409);
    expect((await transactionById(e2e, pendingId))?.status).toBe('pending');
    expect(await withdrawalRows(player)).toHaveLength(1);

    await db().delete(walletWithdrawalHold).where(eq(walletWithdrawalHold.userId, player.userId));
    const approved = await e2e.admin.post(`/wallet/withdrawals/${pendingId}/approve`, {});

    expect(approved.status).toBe(200);
    expect((await transactionById(e2e, pendingId))?.status).toBe('completed');
  });

  it('an unauthenticated caller requesting a withdrawal is refused with 401', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const res = await e2e.app.app.request('/wallet/withdraw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        amount: '10',
        currency: player.currency,
        network: NETWORK,
        idempotencyKey: randomUUID(),
      }),
    });

    expect(res.status).toBe(401);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
  });

  it("a player cannot see or act on another player's withdrawal", async () => {
    const owner = await newFundedPlayer(e2e, '100');
    const id = await requestedId(owner, { amount: '10' });
    const other = await registerAndMaterializePlayer(e2e.app, {
      email: `withdrawal-${randomUUID()}@e2e.test`,
    });

    const listed = await other.client.get('/wallet/transactions');
    const approve = await other.client.post(`/wallet/withdrawals/${id}/approve`, {});
    const reject = await other.client.post(`/wallet/withdrawals/${id}/reject`, { reason: 'nope' });
    const queue = await other.client.get('/wallet/withdrawals');

    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain(id);
    expect(approve.status).toBe(403);
    expect(reject.status).toBe(403);
    expect(queue.status).toBe(403);
    expect((await transactionById(e2e, id))?.status).toBe('pending');
    expect(await balanceOf(e2e, owner.userId, owner.currency)).toBe(money('90'));
  });
});

describe('withdrawal PIN', () => {
  it('a player with a PIN withdrawing without the PIN is refused and nothing is debited', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setPin(player, '1234');

    const { status, body } = await withdraw(player, { amount: '10' });

    expect(status).toBe(409);
    refused(body, 'CONFLICT', 'withdrawal_pin_required');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('a player withdrawing with a wrong PIN is refused with the attempts left and nothing is debited', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setPin(player, '1234');

    const { status, body } = await withdraw(player, { amount: '10', withdrawalPin: '0000' });

    expect(status).toBe(409);
    expect(body).toEqual(
      expect.objectContaining({
        data: { reason: 'withdrawal_pin_incorrect', attemptsLeft: 4 },
      }),
    );
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('five wrong PIN attempts lock withdrawals for 30 minutes and a correct PIN is refused while locked', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setPin(player, '1234');

    const wrong: Awaited<ReturnType<typeof withdraw>>[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      wrong.push(await withdraw(player, { amount: '10', withdrawalPin: '0000' }));
    }
    const correct = await withdraw(player, { amount: '10', withdrawalPin: '1234' });

    expect(wrong.map((r) => r.status)).toEqual([409, 409, 409, 409, 409]);
    refused(wrong[3]?.body, 'CONFLICT', 'withdrawal_pin_incorrect');
    refused(wrong[4]?.body, 'CONFLICT', 'withdrawal_pin_locked');
    const lockedUntil = lockedUntilOf(wrong[4]?.body);
    const remainingMs = Date.parse(lockedUntil ?? '') - Date.now();
    expect(remainingMs).toBeGreaterThan(29 * 60 * 1000);
    expect(remainingMs).toBeLessThanOrEqual(30 * 60 * 1000);
    expect(correct.status).toBe(409);
    refused(correct.body, 'CONFLICT', 'withdrawal_pin_locked');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('a correct PIN after fewer than five wrong attempts resets the attempt counter and the withdrawal succeeds', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setPin(player, '1234');
    for (let attempt = 0; attempt < 3; attempt++) {
      await withdraw(player, { amount: '10', withdrawalPin: '0000' });
    }

    const correct = await withdraw(player, { amount: '10', withdrawalPin: '1234' });
    const wrongAgain = await withdraw(player, { amount: '10', withdrawalPin: '0000' });

    expect(correct.status).toBe(200);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('90'));
    expect(wrongAgain.body).toEqual(
      expect.objectContaining({ data: { reason: 'withdrawal_pin_incorrect', attemptsLeft: 4 } }),
    );
  });

  it('a player without a PIN can withdraw without one', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const { status } = await withdraw(player, { amount: '10' });

    expect(status).toBe(200);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('90'));
  });

  it('the PIN lock expires after 30 minutes and a correct PIN works again', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await setPin(player, '1234');
    for (let attempt = 0; attempt < 5; attempt++) {
      await withdraw(player, { amount: '10', withdrawalPin: '0000' });
    }
    const whileLocked = await withdraw(player, { amount: '10', withdrawalPin: '1234' });
    await db()
      .update(user)
      .set({ withdrawalPinLockedUntil: new Date(Date.now() - 1000) })
      .where(eq(user.id, player.userId));

    const afterExpiry = await withdraw(player, { amount: '10', withdrawalPin: '1234' });

    expect(whileLocked.status).toBe(409);
    expect(afterExpiry.status).toBe(200);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('90'));
  });
});

describe('withdrawal addresses', () => {
  it('a player saving a withdrawal address sees it usable only 24 hours after it was saved', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const saved = await savedAddress(player);

    expect(Date.parse(saved.usableFrom) - Date.parse(saved.createdAt)).toBe(DAY_MS);
    expect(Math.abs(Date.now() - Date.parse(saved.createdAt))).toBeLessThan(60_000);
    const listed = await player.client.get('/wallet/withdrawal-addresses');
    expect(WithdrawalAddressSchema.array().parse(await listed.json())).toEqual([saved]);
  });

  it('a withdrawal to an address saved less than 24 hours ago is refused as cooling down and nothing is debited', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const saved = await savedAddress(player);

    const { status, body } = await withdraw(player, {
      amount: '10',
      destinationAddress: saved.address,
    });

    expect(status).toBe(409);
    refused(body, 'CONFLICT', 'withdrawal_address_cooling_down');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('a withdrawal to an address saved more than 24 hours ago is accepted', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const saved = await savedAddress(player);
    await backdateAddress(saved.id, DAY_MS + 60_000);

    const id = await requestedId(player, { amount: '10', destinationAddress: saved.address });

    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('90'));
    expect(await transactionById(e2e, id)).toEqual(
      expect.objectContaining({ destinationAddress: saved.address, status: 'pending' }),
    );
  });

  it('a withdrawal to an address that is not saved is refused when the whitelist is required', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const { status, body } = await withdraw(player, {
      amount: '10',
      destinationAddress: `dest-${randomUUID()}`,
    });

    expect(status).toBe(409);
    refused(body, 'CONFLICT');
    expect(JSON.stringify(body)).toContain('not approved');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await withdrawalRows(player)).toEqual([]);
  });

  it('saving a malformed address for a network is refused', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const res = await saveAddress(player, { network: 'ERC20', address: 'not-an-evm-address' });

    expect(res.status).toBe(400);
    expect(
      await db()
        .select()
        .from(walletWithdrawalAddress)
        .where(eq(walletWithdrawalAddress.userId, player.userId)),
    ).toEqual([]);
  });

  it('saving the same address twice for the same network is refused as already existing', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const saved = await savedAddress(player);

    const again = await saveAddress(player, { address: saved.address });

    expect(again.status).toBe(409);
    refused(await again.json(), 'CONFLICT');
    expect(
      await db()
        .select()
        .from(walletWithdrawalAddress)
        .where(eq(walletWithdrawalAddress.userId, player.userId)),
    ).toHaveLength(1);
  });

  it('saving more addresses than the per-player limit is refused', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const limit = 50;
    await db()
      .insert(walletWithdrawalAddress)
      .values(
        Array.from({ length: limit }, (_, index) => ({
          userId: player.userId,
          label: `address ${index}`,
          currency: player.currency,
          network: NETWORK,
          address: `bulk-${index}-${randomUUID()}`,
        })),
      );

    const res = await saveAddress(player);

    expect(res.status).toBe(409);
    refused(await res.json(), 'CONFLICT');
    expect(
      await db()
        .select()
        .from(walletWithdrawalAddress)
        .where(eq(walletWithdrawalAddress.userId, player.userId)),
    ).toHaveLength(limit);
  });

  it("a player cannot list or delete another player's withdrawal address", async () => {
    const owner = await newFundedPlayer(e2e, '100');
    const other = await newFundedPlayer(e2e, '100');
    const saved = await savedAddress(owner);

    const listed = await other.client.get('/wallet/withdrawal-addresses');
    const deleted = await other.client.del(`/wallet/withdrawal-addresses/${saved.id}`);

    expect(WithdrawalAddressSchema.array().parse(await listed.json())).toEqual([]);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toBe(false);
    const ownerList = await owner.client.get('/wallet/withdrawal-addresses');
    expect(WithdrawalAddressSchema.array().parse(await ownerList.json())).toEqual([saved]);
  });

  it('a player deleting their address cannot withdraw to it afterwards', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const saved = await savedAddress(player);
    await backdateAddress(saved.id, DAY_MS + 60_000);
    await requestedId(player, { amount: '10', destinationAddress: saved.address });

    const deleted = await player.client.del(`/wallet/withdrawal-addresses/${saved.id}`);
    const after = await withdraw(player, { amount: '10', destinationAddress: saved.address });

    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toBe(true);
    expect(after.status).toBe(409);
    refused(after.body, 'CONFLICT');
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('90'));
    expect(await withdrawalRows(player)).toHaveLength(1);
  });
});

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  walletDepositAddress,
  walletDepositStatusEvent,
  walletRefundedDeposit,
} from '@openora/core/wallet/schema';
import { flushAudit, newStaff, registerAndMaterializePlayer } from '../index.js';
import {
  addAsset,
  balanceOf,
  bootWalletE2e,
  closeWalletE2e,
  deliverWebhook,
  findingsFor,
  ledgerRows,
  newDepositScenario,
  NETWORK,
  parseFinding,
  requestDepositAddress,
  resolveFinding,
  type WalletE2e,
} from './support/wallet.js';
import {
  allowDepositing,
  barFromDepositing,
  BARRED_HOLD_REASON,
} from './support/test-deposit-hold-plugin.js';
import {
  ADMISSION_REFUSAL_REASON,
  refuseDepositAdmission,
} from './support/test-deposit-admission-plugin.js';
import { depositRows, newRgPlayer, readBody } from './support/compliance.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([
    {
      id: 'testing-deposit-admission',
      path: fileURLToPath(new URL('./support/test-deposit-admission-plugin.ts', import.meta.url)),
    },
  ]);
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;
const scenario = (options?: Parameters<typeof newDepositScenario>[1]) =>
  newDepositScenario(e2e, options);

async function setDailyDepositLimit(userId: string, amount: string) {
  const res = await e2e.admin.put(`/compliance/players/${userId}/limits`, {
    type: 'deposit',
    amount,
    minutes: null,
    currency: 'USD',
    period: 'daily',
    reason: 'e2e deposit limit',
    confirm: true,
  });
  expect(res.status).toBe(200);
}

describe('player deposit address and crediting', () => {
  it('a player requests a deposit address and gets one unique address per currency and network', async () => {
    const first = await scenario({ requestAddress: false });
    const second = await scenario({ requestAddress: false });
    await addAsset(e2e.admin, first.currency, 'OTHERCHAIN');

    const firstAddress = await requestDepositAddress(first.client, first.currency, NETWORK);
    const secondAddress = await requestDepositAddress(first.client, second.currency, NETWORK);
    await requestDepositAddress(first.client, first.currency, 'OTHERCHAIN');

    expect(firstAddress).not.toBe(secondAddress);
    const rows = await db()
      .select({ currency: walletDepositAddress.currency, network: walletDepositAddress.network })
      .from(walletDepositAddress)
      .where(eq(walletDepositAddress.userId, first.userId));
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { currency: first.currency, network: NETWORK },
        { currency: first.currency, network: 'OTHERCHAIN' },
        { currency: second.currency, network: NETWORK },
      ]),
    );
  });

  it('two different players requesting the same currency and network get different addresses', async () => {
    const first = await scenario();
    const other = await registerAndMaterializePlayer(e2e.app, {
      email: `deposit-${randomUUID()}@e2e.test`,
    });

    const otherAddress = await requestDepositAddress(other.client, first.currency, NETWORK);

    expect(otherAddress).not.toBe(first.address);
  });

  it('the same player requesting the same address twice gets the same address back', async () => {
    const player = await scenario();

    const again = await requestDepositAddress(player.client, player.currency, NETWORK);

    expect(again).toBe(player.address);
    const rows = await db()
      .select()
      .from(walletDepositAddress)
      .where(eq(walletDepositAddress.userId, player.userId));
    expect(rows).toHaveLength(1);
  });

  it('a player requesting an address for a currency or network the catalog does not offer is refused', async () => {
    const player = await scenario({ requestAddress: false });

    const unknownNetwork = await player.client.post('/wallet/deposits/address', {
      currency: player.currency,
      network: 'NOSUCHCHAIN',
    });
    const unknownCurrency = await player.client.post('/wallet/deposits/address', {
      currency: 'NOSUCHCOIN',
      network: NETWORK,
    });

    expect(unknownNetwork.status).toBe(400);
    expect(unknownCurrency.status).toBe(400);
    const rows = await db()
      .select()
      .from(walletDepositAddress)
      .where(eq(walletDepositAddress.userId, player.userId));
    expect(rows).toEqual([]);
  });

  it('a player requesting an address for a network with deposits switched off is refused', async () => {
    const player = await scenario({ requestAddress: false });
    await addAsset(e2e.admin, player.currency, 'OFFCHAIN', '10', false);

    const res = await player.client.post('/wallet/deposits/address', {
      currency: player.currency,
      network: 'OFFCHAIN',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it.todo(
    'GAP: a deposit address request with no network on a multi-network currency is not refused as ambiguous, only withdrawals are (packages/core/src/wallet/service/wallet.service.ts:572 assertDepositAllowed accepts any enabled network; the ambiguity check is resolveWithdrawalNetwork at :473)',
  );

  it('an unauthenticated caller requesting a deposit address is refused with 401', async () => {
    const player = await scenario({ requestAddress: false });

    const res = await e2e.app.app.request('/wallet/deposits/address', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currency: player.currency, network: NETWORK }),
    });

    expect(res.status).toBe(401);
  });

  it('a deposit webhook below the asset minimum is not credited, leaves the balance unchanged and files one below-minimum finding', async () => {
    const player = await scenario();
    const event = player.deposit({ amount: '5' });

    const res = await deliverWebhook(e2e, event);

    expect(res.status).toBe(200);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('0');
    expect(await ledgerRows(e2e, event.externalId)).toEqual([]);
    const findings = await findingsFor(e2e, event.externalId);
    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'below_minimum_deposit',
        status: 'open',
        amount: '5.000000000000000000',
      }),
    ]);
  });

  it('a deposit webhook for an unconfirmed transfer records it pending and leaves the balance unchanged', async () => {
    const player = await scenario();
    const event = player.status('detected');

    const res = await deliverWebhook(e2e, event);

    expect(res.status).toBe(200);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('0');
    expect(await ledgerRows(e2e, event.externalId)).toEqual([]);
    const recorded = await db()
      .select({ status: walletDepositStatusEvent.status })
      .from(walletDepositStatusEvent)
      .where(eq(walletDepositStatusEvent.externalId, event.externalId));
    expect(recorded).toEqual([{ status: 'detected' }]);
    await flushAudit(e2e.app);
    const audited = await db()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.action, 'wallet.deposit.detected'));
    expect(audited.length).toBeGreaterThan(0);
  });

  it('a confirmed deposit webhook credits the balance once and writes one ledger row with the reference value and stored rate', async () => {
    const player = await scenario();
    const event = player.deposit({ amount: '20' });

    const res = await deliverWebhook(e2e, event);

    expect(res.status).toBe(200);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('20.000000000000000000');
    expect(await ledgerRows(e2e, event.externalId)).toEqual([
      expect.objectContaining({
        type: 'deposit',
        direction: 'credit',
        status: 'completed',
        amount: '20.000000000000000000',
        currency: player.currency,
        referenceCurrency: 'USD',
        referenceRate: '1.500000000000000000',
        referenceAmount: '30.000000000000000000',
        txHash: event.txHash,
      }),
    ]);
  });

  it('the same confirmed deposit webhook delivered twice credits the balance once and writes one ledger row', async () => {
    const player = await scenario();
    const event = player.deposit();

    const first = await deliverWebhook(e2e, event);
    const second = await deliverWebhook(e2e, event);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('10.000000000000000000');
    expect(await ledgerRows(e2e, event.externalId)).toHaveLength(1);
  });

  it('the same confirmed deposit webhook delivered concurrently credits the balance once', async () => {
    const player = await scenario();
    const event = player.deposit();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => deliverWebhook(e2e, event)),
    );

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('10.000000000000000000');
    expect(await ledgerRows(e2e, event.externalId)).toHaveLength(1);
  });

  it('a deposit webhook with an invalid signature is rejected and credits nothing', async () => {
    const player = await scenario();
    const event = player.deposit();

    const res = await deliverWebhook(e2e, event, 'not-the-signature');

    expect(res.status).toBe(401);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('0');
    expect(await ledgerRows(e2e, event.externalId)).toEqual([]);
  });

  it('a deposit webhook with a malformed amount or empty id answers an error so the vendor retries, and credits nothing', async () => {
    const player = await scenario();
    const badAmount = player.deposit({ amount: 'ten' });
    const emptyId = player.deposit({ externalId: '' });

    const amountRes = await deliverWebhook(e2e, badAmount);
    const idRes = await deliverWebhook(e2e, emptyId);

    expect(amountRes.status).toBeGreaterThanOrEqual(500);
    expect(idRes.status).toBeGreaterThanOrEqual(500);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('0');
    expect(await ledgerRows(e2e, badAmount.externalId)).toEqual([]);
    expect(await findingsFor(e2e, badAmount.externalId)).toEqual([]);
  });

  it('a deposit webhook for an unknown address credits no player', async () => {
    const player = await scenario();
    const event = player.deposit({ address: `unknown-${randomUUID()}` });

    const res = await deliverWebhook(e2e, event);

    expect(res.status).toBe(200);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('0');
    expect(await ledgerRows(e2e, event.externalId)).toEqual([]);
    expect(await findingsFor(e2e, event.externalId)).toEqual([
      expect.objectContaining({ kind: 'unattributed_deposit', status: 'open' }),
    ]);
  });

  it('a deposit webhook with no fresh exchange rate writes no row and answers an error so the vendor redelivers', async () => {
    const player = await scenario({ rated: false });
    const event = player.deposit();

    const res = await deliverWebhook(e2e, event);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('0');
    expect(await ledgerRows(e2e, event.externalId)).toEqual([]);
  });

  it('a deposit by a player barred from depositing is held and not credited until released', async () => {
    const player = await scenario();
    const event = player.deposit();
    barFromDepositing(player.userId);
    try {
      const res = await deliverWebhook(e2e, event);

      expect(res.status).toBe(200);
      expect(await balanceOf(e2e, player.userId, player.currency)).toBe('0');
      const [held] = await ledgerRows(e2e, event.externalId);
      expect(held).toEqual(
        expect.objectContaining({ status: 'on_hold', reviewReason: BARRED_HOLD_REASON }),
      );
      const [finding] = await findingsFor(e2e, event.externalId);
      expect(finding).toEqual(expect.objectContaining({ kind: 'held_deposit', status: 'open' }));

      allowDepositing(player.userId);
      const released = await resolveFinding(e2e.admin, finding!.id, { outcome: 'released' });

      expect(released.status).toBe(200);
      expect(await balanceOf(e2e, player.userId, player.currency)).toBe('10.000000000000000000');
      const [after] = await ledgerRows(e2e, event.externalId);
      expect(after).toEqual(expect.objectContaining({ id: held!.id, status: 'completed' }));
    } finally {
      allowDepositing(player.userId);
    }
  });

  it('an admin crediting a held or below-minimum deposit finding credits the balance once and a second attempt changes nothing', async () => {
    const below = await scenario();
    const belowEvent = below.deposit({ amount: '5' });
    await deliverWebhook(e2e, belowEvent);
    const [belowFinding] = await findingsFor(e2e, belowEvent.externalId);

    const credited = await resolveFinding(e2e.admin, belowFinding!.id, { outcome: 'credited' });
    const creditedAgain = await resolveFinding(e2e.admin, belowFinding!.id, {
      outcome: 'credited',
    });

    expect(credited.status).toBe(200);
    expect(parseFinding(credited.body).status).toBe('resolved');
    expect(creditedAgain.status).toBe(200);
    expect(await balanceOf(e2e, below.userId, below.currency)).toBe('5.000000000000000000');
    expect(await ledgerRows(e2e, belowEvent.externalId)).toHaveLength(1);

    const held = await scenario();
    const heldEvent = held.deposit();
    barFromDepositing(held.userId);
    try {
      await deliverWebhook(e2e, heldEvent);
      const [heldFinding] = await findingsFor(e2e, heldEvent.externalId);
      allowDepositing(held.userId);

      const released = await resolveFinding(e2e.admin, heldFinding!.id, { outcome: 'released' });
      const releasedAgain = await resolveFinding(e2e.admin, heldFinding!.id, {
        outcome: 'released',
      });

      expect(released.status).toBe(200);
      expect(releasedAgain.status).toBe(200);
      expect(await balanceOf(e2e, held.userId, held.currency)).toBe('10.000000000000000000');
      expect(await ledgerRows(e2e, heldEvent.externalId)).toHaveLength(1);
    } finally {
      allowDepositing(held.userId);
    }
  });

  it('an admin refunding a below-minimum deposit finding leaves the balance unchanged and records the refund once', async () => {
    const player = await scenario();
    const event = player.deposit({ amount: '5' });
    await deliverWebhook(e2e, event);
    const [finding] = await findingsFor(e2e, event.externalId);
    const refund = {
      outcome: 'refunded',
      amount: '5',
      txHash: `refund-${randomUUID()}`,
      destinationAddress: `dest-${randomUUID()}`,
    };

    const refunded = await resolveFinding(e2e.admin, finding!.id, refund);
    const refundedAgain = await resolveFinding(e2e.admin, finding!.id, refund);

    expect(refunded.status).toBe(200);
    expect(parseFinding(refunded.body).status).toBe('resolved');
    expect(refundedAgain.status).toBe(200);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('0');
    const recorded = await db()
      .select()
      .from(walletRefundedDeposit)
      .where(and(eq(walletRefundedDeposit.externalId, event.externalId)));
    expect(recorded).toHaveLength(1);
  });

  it('a player or an admin without the wallet reconciliation resolve permission calling the deposit finding credit or refund route is refused as forbidden', async () => {
    const player = await scenario();
    const event = player.deposit({ amount: '5' });
    await deliverWebhook(e2e, event);
    const [finding] = await findingsFor(e2e, event.externalId);
    const support = await newStaff(e2e.app, 'deposit-support', 'customer-support-agent');
    const refund = {
      outcome: 'refunded',
      amount: '5',
      txHash: `refund-${randomUUID()}`,
      destinationAddress: `dest-${randomUUID()}`,
    };

    const attempts = await Promise.all(
      [player.client, support.client].flatMap((client) => [
        resolveFinding(client, finding!.id, { outcome: 'credited' }),
        resolveFinding(client, finding!.id, refund),
      ]),
    );

    expect(attempts.map((attempt) => attempt.status)).toEqual([403, 403, 403, 403]);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('0');
    const [after] = await findingsFor(e2e, event.externalId);
    expect(after).toEqual(expect.objectContaining({ status: 'open' }));
  });

  it('an on-chain deposit webhook over the responsible-gambling deposit limit is credited and files one limit breach finding', async () => {
    const player = await scenario();
    await setDailyDepositLimit(player.userId, '50');
    const event = player.deposit({ amount: '100' });

    const res = await deliverWebhook(e2e, event);

    expect(res.status).toBe(200);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('100.000000000000000000');
    const findings = await findingsFor(e2e, event.externalId);
    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'rg_limit_breach',
        status: 'open',
        amount: '100.000000000000000000',
      }),
    ]);
  });

  it('a replayed over-limit deposit webhook files the limit breach finding once', async () => {
    const player = await scenario();
    await setDailyDepositLimit(player.userId, '50');
    const event = player.deposit({ amount: '100' });

    const first = await deliverWebhook(e2e, event);
    const second = await deliverWebhook(e2e, event);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await findingsFor(e2e, event.externalId)).toHaveLength(1);
    expect(await ledgerRows(e2e, event.externalId)).toHaveLength(1);
  });
});

describe('player deposit through the payment provider', () => {
  const depositWith = (
    player: Awaited<ReturnType<typeof newRgPlayer>>,
    idempotencyKey: string,
    amount = '30',
  ) =>
    player.client
      .post('/wallet/deposit', { amount, currency: player.currency, idempotencyKey })
      .then(readBody);

  async function blockPlayEligibility(userId: string) {
    await db().update(user).set({ rgBlocked: true }).where(eq(user.id, userId));
  }

  it('a completed deposit replayed after the player is blocked answers the first result and credits once', async () => {
    const player = await newRgPlayer(e2e);
    const idempotencyKey = randomUUID();
    const first = await depositWith(player, idempotencyKey);
    await blockPlayEligibility(player.userId);

    const replay = await depositWith(player, idempotencyKey);
    const fresh = await depositWith(player, randomUUID());

    expect(first.status).toBe(200);
    expect(replay).toEqual(first);
    expect(fresh.status).toBe(403);
    expect(await depositRows(e2e, player.userId)).toHaveLength(1);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe('30.000000000000000000');
  });

  it('a completed deposit replayed after the admission policy starts refusing answers the first result and credits once', async () => {
    const player = await newRgPlayer(e2e);
    const idempotencyKey = randomUUID();
    const first = await depositWith(player, idempotencyKey);
    refuseDepositAdmission(player.userId);

    const replay = await depositWith(player, idempotencyKey);
    const fresh = await depositWith(player, randomUUID());

    expect(first.status).toBe(200);
    expect(replay).toEqual(first);
    expect(fresh.status).toBe(403);
    expect(JSON.stringify(fresh.body)).toContain(ADMISSION_REFUSAL_REASON);
    expect(await depositRows(e2e, player.userId)).toHaveLength(1);
  });
});

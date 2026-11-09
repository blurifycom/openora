import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_PAYMENT_PROVIDER } from '@openora/core/contracts';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import {
  BELOW_FLOOR,
  bootDepositLifecycle,
  FLOOR,
  NETWORK,
  OTHER_NETWORK,
  withoutNetwork,
  type DepositPlayer,
} from './fixtures/wallet-deposit-lifecycle.js';

const {
  drizzle,
  adminClient,
  issueAddress,
  setup,
  deliver,
  auditRows,
  auditTrailOldestFirst: auditTrail,
  guardRows,
  ledgerRows,
  findings,
  balanceOf,
  reconcile,
} = bootDepositLifecycle();

async function withdrawalInFlight({ userId, currency }: DepositPlayer) {
  const [record] = await drizzle()
    .select({ id: wallet.id })
    .from(wallet)
    .where(eq(wallet.userId, userId));
  const externalId = randomUUID();
  await drizzle().insert(walletTransaction).values({
    walletId: record!.id,
    type: 'withdrawal',
    amount: '1',
    currency,
    status: 'processing',
    direction: 'debit',
    rail: 'crypto',
    network: NETWORK,
    providerName: DEFAULT_PAYMENT_PROVIDER,
    providerRefId: externalId,
  });
  return externalId;
}

const outboxPayloads = async (topic: string, transactionId: string) =>
  (
    await drizzle().execute(
      sql`select payload from event_outbox where topic = ${topic} and payload->>'transactionId' = ${transactionId}`,
    )
  ).rows.map((row) => row['payload'] as Record<string, string>);

describe('a malformed status event', () => {
  it('answers an error and writes nothing when the address is nobody’s', async () => {
    const player = await setup();
    const event = player.status('detected', {
      address: `unknown-${randomUUID()}`,
      amount: 'abc',
    });

    const res = await deliver(event);

    expect(res.status).toBe(500);
    expect(await guardRows(event.externalId)).toHaveLength(0);
    expect(await auditRows(event.externalId)).toHaveLength(0);
    expect(await findings(event.externalId)).toHaveLength(0);
  });

  it('answers an error and changes nothing for a deposit that is already credited', async () => {
    const player = await setup();
    const credited = player.deposit();
    await deliver(credited);

    const res = await deliver(
      player.status('failed', { externalId: credited.externalId, amount: 'abc' }),
    );

    expect(res.status).toBe(500);
    expect(await ledgerRows(credited.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
    expect(await auditRows(credited.externalId)).toHaveLength(0);
  });
});

describe('an amount with more decimals than the ledger keeps, below the floor', () => {
  it('answers an error with nothing recorded, and the corrected amount credits on retry', async () => {
    const player = await setup();
    const externalId = randomUUID();

    const refused = await deliver(player.deposit({ externalId, amount: '9.9999999999999999999' }));

    expect(refused.status).toBe(500);
    expect(await guardRows(externalId)).toHaveLength(0);
    expect(await auditRows(externalId)).toHaveLength(0);

    const retried = await deliver(player.deposit({ externalId, amount: '15' }));

    expect(retried.status).toBe(200);
    expect(await ledgerRows(externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(15);
  });
});

describe('the poll, with a malformed status event in the batch', () => {
  it('skips it, audits the good one, moves the withdrawal and finishes the run', async () => {
    const player = await setup();
    await deliver(player.deposit());
    const withdrawalId = await withdrawalInFlight(player);
    const badAmount = player.status('detected', { amount: 'abc' });
    const noId = player.status('failed', { externalId: '' });
    const good = player.status('detected');

    await reconcile([
      badAmount,
      noId,
      good,
      { kind: 'withdrawal', externalId: withdrawalId, status: 'completed' },
    ]);

    expect(await auditRows(badAmount.externalId)).toHaveLength(0);
    expect(await guardRows('')).toHaveLength(0);
    expect(await auditTrail(good.externalId)).toEqual(['detected']);
    expect((await ledgerRows(withdrawalId)).map((row) => row.status)).toEqual(['completed']);
  });
});

describe('a deposit credited after the vendor reported it failed', () => {
  it('writes the completed event in the credit’s own transaction, beside the failed audit row', async () => {
    const player = await setup();
    const failed = player.status('failed');

    await deliver(failed);
    const res = await deliver(player.deposit({ externalId: failed.externalId }));

    expect(res.status).toBe(200);
    const [credit] = await ledgerRows(failed.externalId);
    expect(credit?.status).toBe('completed');
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
    expect(await auditTrail(failed.externalId)).toEqual(['failed']);
    expect(await outboxPayloads('wallet.deposit.completed', credit!.id)).toEqual([
      expect.objectContaining({ userId: player.userId, amount: FLOOR, currency: player.currency }),
    ]);
  });
});

describe('a confirmed deposit on an address nobody holds, after status events for it', () => {
  it('files the finding with the confirmed amount, not a status event’s', async () => {
    const player = await setup();
    const address = `unknown-${randomUUID()}`;
    const externalId = randomUUID();

    await deliver(player.status('detected', { address, externalId, amount: '3' }));
    await deliver(player.status('failed', { address, externalId, amount: '4' }));
    const res = await deliver(player.deposit({ address, externalId, amount: '12.5' }));

    expect(res.status).toBe(200);
    const filed = await findings(externalId);
    expect(filed.map((finding) => finding.kind)).toEqual(['unattributed_deposit']);
    expect(Number(filed[0]?.amount)).toBe(12.5);
    expect(await auditRows(externalId)).toHaveLength(0);
  });
});

describe('withdrawal webhook events', () => {
  it('move the withdrawal transaction through the double', async () => {
    const player = await setup();
    await deliver(player.deposit());
    const completing = await withdrawalInFlight(player);
    const failing = await withdrawalInFlight(player);

    await deliver({ kind: 'withdrawal', externalId: completing, status: 'processing' });
    expect((await ledgerRows(completing)).map((row) => row.status)).toEqual(['processing']);

    const txHash = `hash-${randomUUID()}`;
    await deliver({ kind: 'withdrawal', externalId: completing, status: 'completed', txHash });
    await deliver({ kind: 'withdrawal', externalId: failing, status: 'failed' });

    expect((await ledgerRows(completing)).map((row) => [row.status, row.txHash])).toEqual([
      ['completed', txHash],
    ]);
    expect((await ledgerRows(failing)).map((row) => row.status)).toEqual(['failed']);
    expect(await guardRows(completing)).toHaveLength(0);
  });
});

describe('a refused deposit is recoverable', () => {
  it('files one below_minimum_deposit finding carrying where the money is, once however often delivered', async () => {
    const tag = `tag-${randomUUID()}`;
    const player = await setup({ tag });
    const event = player.deposit({
      tag,
      amount: BELOW_FLOOR,
      sourceAddress: `src-${randomUUID()}`,
    });

    await deliver(event);
    await deliver(event);

    const filed = await findings(event.externalId);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      kind: 'below_minimum_deposit',
      status: 'open',
      address: player.address,
      tag,
      txHash: event.txHash,
      sourceAddress: event.sourceAddress,
      currency: player.currency,
      network: NETWORK,
    });
    expect(Number(filed[0]?.amount)).toBe(Number(BELOW_FLOOR));
  });

  async function resolve(id: string, resolution: Record<string, string>) {
    return adminClient().post(`/wallet/reconciliation/${id}/resolve`, { resolution });
  }

  it('credits through the admin route, and a later redelivery stays a no-op', async () => {
    const player = await setup();
    const event = player.deposit({ amount: BELOW_FLOOR });
    await deliver(event);
    const [finding] = await findings(event.externalId);

    const res = await resolve(finding!.id, { outcome: 'credited' });

    expect(res.status).toBe(200);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(BELOW_FLOOR));
    expect((await ledgerRows(event.externalId)).map((row) => row.status)).toEqual(['completed']);

    const redelivered = await deliver(event);

    expect(redelivered.status).toBe(200);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(BELOW_FLOOR));
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
  });

  it('refunds through the admin route, and a later redelivery credits nothing', async () => {
    const player = await setup();
    const event = player.deposit({ amount: BELOW_FLOOR });
    await deliver(event);
    const [finding] = await findings(event.externalId);

    const res = await resolve(finding!.id, {
      outcome: 'refunded',
      amount: BELOW_FLOOR,
      txHash: `refund-${randomUUID()}`,
      destinationAddress: `dest-${randomUUID()}`,
    });

    expect(res.status).toBe(200);
    expect((await ledgerRows(event.externalId)).map((row) => row.status)).toEqual(['refunded']);

    const redelivered = await deliver(event);

    expect(redelivered.status).toBe(200);
    expect(await balanceOf(player.userId, player.currency)).toBe(0);
    expect((await ledgerRows(event.externalId)).map((row) => row.status)).toEqual(['refunded']);
  });

  it('leaves a refused deposit out of the open findings the alert counts', async () => {
    const player = await setup();
    const before = await reconcile([]);

    await deliver(player.deposit({ amount: BELOW_FLOOR }));
    const after = await reconcile([]);

    expect(after.summary?.['openFindings']).toBe(before.summary?.['openFindings']);
  });
});

describe('the floor when the event names no network', () => {
  async function onTwoNetworks() {
    const player = await setup({
      assets: [
        { network: NETWORK, minDeposit: FLOOR },
        { network: OTHER_NETWORK, minDeposit: '1' },
      ],
    });
    await issueAddress(player.client, player.currency, OTHER_NETWORK);
    return player;
  }

  it('applies the lowest row when the address was issued on two networks', async () => {
    const player = await onTwoNetworks();
    const event = withoutNetwork(player.deposit({ amount: BELOW_FLOOR }));

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await auditTrail(event.externalId)).toEqual([]);
  });

  it('still refuses under that lowest row', async () => {
    const player = await onTwoNetworks();
    const event = withoutNetwork(player.deposit({ amount: '0.5' }));

    await deliver(event);

    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
  });
});

describe('an event checked at entry', () => {
  it('refuses to credit an empty id', async () => {
    const player = await setup();
    const before = (await ledgerRows('')).length;

    const res = await deliver(player.deposit({ externalId: '' }));

    expect(res.status).toBe(500);
    expect(await ledgerRows('')).toHaveLength(before);
    expect(await balanceOf(player.userId, player.currency)).toBe(0);
  });

  it('answers an error for more decimals than the ledger keeps, above the floor too', async () => {
    const player = await setup();
    const event = player.deposit({ amount: '15.0000000000000000001' });

    const res = await deliver(event);

    expect(res.status).toBe(500);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });

  it('refuses a zero amount where no floor row applies, with no minimum to report', async () => {
    const player = await setup({ assets: [{ network: OTHER_NETWORK, minDeposit: FLOOR }] });
    const event = player.deposit({ amount: '0' });

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    const [row] = await auditRows(event.externalId);
    expect(row?.action).toBe('wallet.deposit.below_minimum');
    expect(row?.after).toMatchObject({ minDeposit: null });
  });

  it('refuses a zero amount at a floor of zero', async () => {
    const player = await setup({ assets: [{ network: NETWORK, minDeposit: '0' }] });
    const event = player.deposit({ amount: '0' });

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
  });
});

describe('a status event in another currency than its address', () => {
  it('is logged and ignored when the event names no network', async () => {
    const player = await setup();
    const event = withoutNetwork(player.status('detected', { currency: 'ZZZ' }));

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await guardRows(event.externalId)).toHaveLength(0);
    expect(await auditRows(event.externalId)).toHaveLength(0);
  });
});

describe('the poll, with a malformed deposit in the batch', () => {
  it('skips it and still finishes the run', async () => {
    const player = await setup();
    const malformed = player.deposit({ amount: 'abc' });
    const good = player.status('detected');

    const run = await reconcile([malformed, good]);

    expect(run.status).toBe('completed');
    expect(await findings(malformed.externalId)).toHaveLength(0);
    expect(await auditTrail(good.externalId)).toEqual(['detected']);
  });
});

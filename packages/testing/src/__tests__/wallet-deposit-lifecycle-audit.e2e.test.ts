import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DEFAULT_PAYMENT_PROVIDER } from '@openora/core/contracts';
import {
  walletDepositAddress,
  walletReconciliationFinding,
  walletRefundedDeposit,
} from '@openora/core/wallet/schema';
import {
  BELOW_FLOOR,
  bootDepositLifecycle,
  FLOOR,
  NETWORK,
  OTHER_NETWORK,
  withoutNetwork,
} from './fixtures/wallet-deposit-lifecycle.js';

const ONE_UNIT_UNDER_FLOOR = '9.999999999999999999';

const {
  drizzle,
  setMinDeposit,
  setup,
  deliver,
  auditRows,
  ledgerRows,
  findings,
  balanceOf,
  reconcile,
} = bootDepositLifecycle();

async function delivered(event: unknown) {
  const res = await deliver(event);
  expect(res.status).toBe(200);
}

const auditedActions = async (externalId: string) =>
  (await auditRows(externalId)).map((row) => row.action).sort();

async function markRefunded(externalId: string) {
  const [finding] = await drizzle()
    .insert(walletReconciliationFinding)
    .values({
      runId: randomUUID(),
      providerName: DEFAULT_PAYMENT_PROVIDER,
      kind: 'held_deposit',
      externalId,
    })
    .returning({ id: walletReconciliationFinding.id });
  await drizzle()
    .insert(walletRefundedDeposit)
    .values({ providerName: DEFAULT_PAYMENT_PROVIDER, externalId, findingId: finding!.id });
}

describe('a deposit below its asset minimum', () => {
  it('is not credited and leaves one audit row filed under the player with the amount and floor', async () => {
    const { userId, playerId, currency, deposit } = await setup();
    const event = deposit({ amount: BELOW_FLOOR });

    await delivered(event);

    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await balanceOf(userId, currency)).toBe(0);
    const [row, ...rest] = await auditRows(event.externalId);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      action: 'wallet.deposit.below_minimum',
      actorType: 'system',
      resourceType: 'player',
      resourceId: playerId,
      result: 'failure',
    });
    expect(row?.after).toMatchObject({
      amount: BELOW_FLOOR,
      currency,
      network: NETWORK,
      externalId: event.externalId,
      minDeposit: expect.stringMatching(/^10\.0+$/),
    });
  });

  it('credits a deposit exactly at the floor and refuses one unit under it', async () => {
    const { userId, currency, deposit } = await setup();
    const atFloor = deposit({ amount: FLOOR });
    const underFloor = deposit({ amount: ONE_UNIT_UNDER_FLOOR });

    await delivered(atFloor);
    await delivered(underFloor);

    expect(await ledgerRows(atFloor.externalId)).toHaveLength(1);
    expect(await auditedActions(atFloor.externalId)).toEqual([]);
    expect(await ledgerRows(underFloor.externalId)).toHaveLength(0);
    expect(await auditedActions(underFloor.externalId)).toEqual(['wallet.deposit.below_minimum']);
    expect(await balanceOf(userId, currency)).toBe(Number(FLOOR));
  });

  it('uses the row of the network the vendor reported, not a cheaper sibling', async () => {
    const { deposit } = await setup({
      assets: [
        { network: NETWORK, minDeposit: FLOOR },
        { network: OTHER_NETWORK, minDeposit: '1' },
      ],
    });
    const event = deposit({ amount: BELOW_FLOOR });

    await delivered(event);

    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });

  it('falls back to the network the address was issued on when the event names none', async () => {
    const { deposit } = await setup({
      assets: [
        { network: NETWORK, minDeposit: FLOOR },
        { network: OTHER_NETWORK, minDeposit: '1' },
      ],
    });
    const event = withoutNetwork(deposit({ amount: BELOW_FLOOR }));

    await delivered(event);

    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await auditedActions(event.externalId)).toEqual(['wallet.deposit.below_minimum']);
  });

  it('still applies the floor of a row with deposits switched off', async () => {
    const { deposit } = await setup({
      assets: [{ network: NETWORK, minDeposit: FLOOR, depositEnabled: false }],
    });
    const event = deposit({ amount: BELOW_FLOOR });

    await delivered(event);

    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await auditedActions(event.externalId)).toEqual(['wallet.deposit.below_minimum']);
  });

  it('credits as before when the reported network has no asset row', async () => {
    const { deposit } = await setup({
      assets: [{ network: OTHER_NETWORK, minDeposit: FLOOR }],
    });
    const event = deposit({ amount: BELOW_FLOOR });

    await delivered(event);

    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await auditedActions(event.externalId)).toEqual([]);
  });

  it('applies the lowest row when neither the event nor the address names a network', async () => {
    const { deposit } = await setup({
      assets: [
        { network: NETWORK, minDeposit: FLOOR },
        { network: OTHER_NETWORK, minDeposit: '6' },
      ],
      addressNetwork: null,
    });
    const under = withoutNetwork(deposit({ amount: BELOW_FLOOR }));
    const over = withoutNetwork(deposit({ amount: '7' }));

    await delivered(under);
    await delivered(over);

    expect(await ledgerRows(under.externalId)).toHaveLength(0);
    expect(await ledgerRows(over.externalId)).toHaveLength(1);
  });

  it('audits once when delivered twice at once, and stays refused after the minimum drops', async () => {
    const { userId, currency, deposit } = await setup();
    const event = deposit({ amount: BELOW_FLOOR });

    const responses = await Promise.all([deliver(event), deliver(event)]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    await setMinDeposit(currency, '1');
    await delivered(event);

    expect(await auditedActions(event.externalId)).toEqual(['wallet.deposit.below_minimum']);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await balanceOf(userId, currency)).toBe(0);
  });

  it('is settled without a fresh rate, while an at-floor deposit still fails for the retry', async () => {
    const { deposit } = await setup({ rated: false });
    const under = deposit({ amount: BELOW_FLOOR });
    const atFloor = deposit({ amount: FLOOR });

    await delivered(under);
    const res = await deliver(atFloor);

    expect(await auditedActions(under.externalId)).toEqual(['wallet.deposit.below_minimum']);
    expect(res.ok).toBe(false);
    expect(await ledgerRows(atFloor.externalId)).toHaveLength(0);
  });
});

describe('a credited deposit', () => {
  it('stays a no-op on redelivery after the minimum has risen', async () => {
    const { userId, currency, deposit } = await setup();
    const event = deposit({ amount: FLOOR });

    await delivered(event);
    await setMinDeposit(currency, '100');
    await delivered(event);

    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await auditedActions(event.externalId)).toEqual([]);
    expect(await balanceOf(userId, currency)).toBe(Number(FLOOR));
  });
});

describe('deposit_status events', () => {
  it('audits a detected deposit once however often it is delivered, and moves no money', async () => {
    const { userId, playerId, currency, status } = await setup();
    const event = status('detected');

    await delivered(event);
    await delivered(event);
    await delivered(event);

    const [row, ...rest] = await auditRows(event.externalId);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      action: 'wallet.deposit.detected',
      actorType: 'system',
      resourceType: 'player',
      resourceId: playerId,
    });
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await balanceOf(userId, currency)).toBe(0);
  });

  it('audits detected and then failed as one row each, the failure marked as one', async () => {
    const { status } = await setup();
    const externalId = randomUUID();

    await delivered(status('detected', { externalId }));
    await delivered(status('failed', { externalId, vendorStatus: 'REJECTED' }));

    const rows = await auditRows(externalId);
    expect(rows.map((row) => row.action).sort()).toEqual([
      'wallet.deposit.detected',
      'wallet.deposit.failed',
    ]);
    const failed = rows.find((row) => row.action === 'wallet.deposit.failed');
    expect(failed?.result).toBe('failure');
    expect(failed?.after).toMatchObject({ vendorStatus: 'REJECTED' });
  });

  it.each(['detected', 'failed'] as const)(
    'adds no row for a late %s after the deposit was credited',
    async (late) => {
      const { deposit, status } = await setup();
      const externalId = randomUUID();

      await delivered(deposit({ externalId }));
      await delivered(status(late, { externalId }));

      expect(await auditedActions(externalId)).toEqual([]);
    },
  );

  it.each(['detected', 'failed'] as const)(
    'adds no row for a late %s after the deposit was refunded',
    async (late) => {
      const { status } = await setup();
      const externalId = randomUUID();
      await markRefunded(externalId);

      await delivered(status(late, { externalId }));

      expect(await auditedActions(externalId)).toEqual([]);
    },
  );

  it('adds no detected row after a failed one', async () => {
    const { status } = await setup();
    const externalId = randomUUID();

    await delivered(status('failed', { externalId }));
    await delivered(status('detected', { externalId }));

    expect(await auditedActions(externalId)).toEqual(['wallet.deposit.failed']);
  });

  it('adds no failed row after the deposit was refused below minimum', async () => {
    const { deposit, status } = await setup();
    const externalId = randomUUID();

    await delivered(deposit({ externalId, amount: BELOW_FLOOR }));
    await delivered(status('failed', { externalId, amount: BELOW_FLOOR }));

    expect(await auditedActions(externalId)).toEqual(['wallet.deposit.below_minimum']);
  });

  it('still credits a confirmed deposit the vendor earlier reported as failed', async () => {
    const { userId, currency, deposit, status } = await setup();
    const externalId = randomUUID();

    await delivered(status('failed', { externalId }));
    await delivered(deposit({ externalId }));

    expect(await ledgerRows(externalId)).toHaveLength(1);
    expect(await balanceOf(userId, currency)).toBe(Number(FLOOR));
    expect(await auditedActions(externalId)).toEqual(['wallet.deposit.failed']);
  });

  it('refuses a bad signature and writes nothing', async () => {
    const { status } = await setup();
    const event = status('detected');

    const res = await deliver(event, 'not-the-signature');

    expect(res.status).toBe(401);
    expect(await auditedActions(event.externalId)).toEqual([]);
  });

  it('ignores an unknown address, leaving the confirmed event to file its finding', async () => {
    const { deposit, status } = await setup();
    const address = `unknown-${randomUUID()}`;
    const externalId = randomUUID();

    await delivered(status('detected', { address, externalId }));
    await delivered(status('failed', { address, externalId }));
    expect(await findings(externalId)).toHaveLength(0);
    expect(await auditedActions(externalId)).toEqual([]);

    await delivered(deposit({ address, externalId }));
    expect((await findings(externalId)).map((finding) => finding.kind)).toEqual([
      'unattributed_deposit',
    ]);
    expect(await auditedActions(externalId)).toEqual([]);
  });

  it('ignores an address shared by two players on different networks', async () => {
    const first = await setup();
    const second = await setup();
    await drizzle()
      .update(walletDepositAddress)
      .set({ address: first.address, network: OTHER_NETWORK })
      .where(eq(walletDepositAddress.userId, second.userId));
    const event = withoutNetwork(first.status('detected'));

    await delivered(event);

    expect(await auditedActions(event.externalId)).toEqual([]);
    expect(await findings(event.externalId)).toHaveLength(0);
  });

  it('keeps the address, tag and hash out of the audit row', async () => {
    const tag = `tag-${randomUUID()}`;
    const { address, status, deposit } = await setup({ tag });
    const statusEvent = status('detected', { tag, txHash: `hash-${randomUUID()}` });
    const belowMinimum = deposit({
      tag,
      amount: BELOW_FLOOR,
      sourceAddress: `src-${randomUUID()}`,
    });

    await delivered(statusEvent);
    await delivered(belowMinimum);

    const stored = JSON.stringify([
      ...(await auditRows(statusEvent.externalId)),
      ...(await auditRows(belowMinimum.externalId)),
    ]);
    expect(stored).toContain(statusEvent.externalId);
    for (const secret of [
      address,
      tag,
      statusEvent.txHash,
      belowMinimum.txHash,
      belowMinimum.sourceAddress,
    ]) {
      expect(stored).not.toContain(secret);
    }
  });
});

describe('reconciliation', () => {
  it('audits a polled below-minimum deposit once and files its own finding, never missing_deposit, however often it runs', async () => {
    const { deposit } = await setup();
    const event = deposit({ amount: BELOW_FLOOR });

    await reconcile([event]);
    await reconcile([event]);

    expect((await findings(event.externalId)).map((finding) => finding.kind)).toEqual([
      'below_minimum_deposit',
    ]);
    expect(await auditedActions(event.externalId)).toEqual(['wallet.deposit.below_minimum']);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });

  it('files a missing_deposit for a deposit at the floor that never reached the ledger', async () => {
    const { deposit } = await setup();
    const event = deposit({ amount: FLOOR });

    await reconcile([event]);

    expect((await findings(event.externalId)).map((finding) => finding.kind)).toEqual([
      'missing_deposit',
    ]);
    expect(await auditedActions(event.externalId)).toEqual([]);
  });

  it('leaves one row for the same status seen by webhook and by poll', async () => {
    const { status } = await setup();
    const event = status('detected');

    await delivered(event);
    await reconcile([event]);

    expect(await auditedActions(event.externalId)).toEqual(['wallet.deposit.detected']);
  });
});

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { walletDepositAddress } from '@openora/core/wallet/schema';
import {
  BELOW_FLOOR,
  bootDepositLifecycle,
  FLOOR,
  NETWORK,
  OTHER_NETWORK,
  withoutNetwork,
} from './fixtures/wallet-deposit-lifecycle.js';

const {
  adminClient,
  drizzle,
  addCurrencyOnSameAddress,
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

const resolve = (id: string, resolution: Record<string, string>) =>
  adminClient().post(`/wallet/reconciliation/${id}/resolve`, { resolution });

const kinds = async (externalId: string) =>
  (await findings(externalId)).map((finding) => finding.kind);

async function addressHoldingAnEarlierCurrency() {
  const player = await setup();
  const currency = await addCurrencyOnSameAddress(player);
  return { ...player, currency, earlierCurrency: player.currency };
}

async function addressOnTwoNetworks() {
  const player = await setup({
    assets: [
      { network: NETWORK, minDeposit: FLOOR },
      { network: OTHER_NETWORK, minDeposit: '1' },
    ],
  });
  await issueAddress(player.client, player.currency, OTHER_NETWORK);
  return player;
}

describe('an event naming no network, on an address holding several currencies', () => {
  it('audits a status event of the later currency', async () => {
    const player = await addressHoldingAnEarlierCurrency();
    const event = withoutNetwork(player.status('detected', { currency: player.currency }));

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await auditTrail(event.externalId)).toEqual(['detected']);
    expect(await guardRows(event.externalId)).toHaveLength(1);
  });

  it('refuses a polled deposit of the later currency under its minimum', async () => {
    const player = await addressHoldingAnEarlierCurrency();
    const event = withoutNetwork(
      player.deposit({ currency: player.currency, amount: BELOW_FLOOR }),
    );

    await reconcile([event]);

    expect(await kinds(event.externalId)).toEqual(['below_minimum_deposit']);
    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
  });

  it('credits a webhook deposit of the later currency, with no mismatch finding', async () => {
    const player = await addressHoldingAnEarlierCurrency();
    const event = withoutNetwork(player.deposit({ currency: player.currency }));

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect((await ledgerRows(event.externalId)).map((row) => row.status)).toEqual(['completed']);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
    expect(await findings(event.externalId)).toHaveLength(0);
  });

  it('still files a currency mismatch when no row is of that currency', async () => {
    const player = await addressHoldingAnEarlierCurrency();
    const event = withoutNetwork(player.deposit({ currency: 'ZZZ' }));

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await kinds(event.externalId)).toEqual(['currency_mismatch']);
  });
});

describe('a refusal naming no network, on an address issued on two networks', () => {
  it('records no network on the finding or the audit row', async () => {
    const player = await addressOnTwoNetworks();
    const event = withoutNetwork(player.deposit({ amount: '0.5' }));

    await deliver(event);

    const [finding] = await findings(event.externalId);
    const [audit] = await auditRows(event.externalId);
    expect(finding?.network).toBeNull();
    expect(audit?.after).toMatchObject({ network: null });
  });

  it('records the network when that currency has only one row', async () => {
    const player = await setup();
    const event = withoutNetwork(player.deposit({ amount: BELOW_FLOOR }));

    await deliver(event);

    const [finding] = await findings(event.externalId);
    const [audit] = await auditRows(event.externalId);
    expect(finding?.network).toBe(NETWORK);
    expect(audit?.after).toMatchObject({ network: NETWORK });
  });
});

describe('a polled deposit whose amount cannot be read', () => {
  it.each(['abc', '15.0000000000000000001'])(
    'files one missing_deposit with no amount and the raw %s, however often polled',
    async (amount) => {
      const player = await setup();
      const event = player.deposit({ amount });

      await reconcile([event]);
      await reconcile([event]);

      const filed = await findings(event.externalId);
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatchObject({ kind: 'missing_deposit', amount: null, status: 'open' });
      expect(filed[0]?.detail).toContain(amount);
    },
  );

  it('cannot be credited through the admin route', async () => {
    const player = await setup();
    const event = player.deposit({ amount: 'abc' });
    await reconcile([event]);
    const [finding] = await findings(event.externalId);

    const res = await resolve(finding!.id, { outcome: 'credited' });

    expect(res.status).toBe(409);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect((await findings(event.externalId))[0]?.status).toBe('open');
  });

  it('files nothing for a blank id', async () => {
    const player = await setup();
    const before = (await findings('')).length;
    const event = player.deposit({ amount: 'abc', externalId: '' });

    const run = await reconcile([event]);

    expect(run.status).toBe('completed');
    expect(await findings('')).toHaveLength(before);
  });

  it('files nothing for a malformed status event', async () => {
    const player = await setup();
    const event = player.status('detected', { amount: 'abc' });

    const run = await reconcile([event]);

    expect(run.status).toBe('completed');
    expect(await findings(event.externalId)).toHaveLength(0);
    expect(await guardRows(event.externalId)).toHaveLength(0);
  });

  it('still answers an error on the webhook', async () => {
    const player = await setup();
    const event = player.deposit({ amount: 'abc' });

    const res = await deliver(event);

    expect(res.status).toBe(500);
    expect(await findings(event.externalId)).toHaveLength(0);
  });
});

describe('a finding for a zero amount', () => {
  const zeroFindings = [
    {
      kind: 'below_minimum_deposit',
      address: undefined,
      credit: (): Record<string, string> => ({ outcome: 'credited' }),
    },
    {
      kind: 'unattributed_deposit',
      address: () => `unknown-${randomUUID()}`,
      credit: (userId: string): Record<string, string> => ({ outcome: 'credited', userId }),
    },
  ] as const;

  it.each(zeroFindings)('$kind cannot be credited, only dismissed', async (scenario) => {
    const player = await setup();
    const event = player.deposit({
      amount: '0',
      ...(scenario.address ? { address: scenario.address() } : {}),
    });
    await deliver(event);
    const [finding] = await findings(event.externalId);
    expect(finding?.kind).toBe(scenario.kind);

    const credit = await resolve(finding!.id, scenario.credit(player.userId));

    expect(credit.status).toBe(409);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect((await findings(event.externalId))[0]?.status).toBe('open');

    const dismiss = await resolve(finding!.id, {
      outcome: 'dismissed',
      note: 'zero-value transfer',
    });

    expect(dismiss.status).toBe(200);
    expect((await findings(event.externalId))[0]?.status).toBe('resolved');
  });
});

/** Makes the row of `currency` the last one stored, so the other row is found first. */
async function storeLast(userId: string, currency: string) {
  const where = and(
    eq(walletDepositAddress.userId, userId),
    eq(walletDepositAddress.currency, currency),
  );
  const [row] = await drizzle().select().from(walletDepositAddress).where(where);
  await drizzle().delete(walletDepositAddress).where(where);
  const { id: _id, ...rest } = row!;
  await drizzle().insert(walletDepositAddress).values(rest);
}

const rowOrders = [
  { order: 'earlier currency first', flip: false },
  { order: 'later currency first', flip: true },
] as const;

describe.each(rowOrders)('an address holding two currencies, $order', ({ flip }) => {
  async function twoCurrencies() {
    const player = await addressHoldingAnEarlierCurrency();
    if (flip) {
      await storeLast(player.userId, player.earlierCurrency);
    }
    return player;
  }

  it('credits each currency once to its own balance, however often delivered', async () => {
    const player = await twoCurrencies();
    const earlier = withoutNetwork(player.deposit({ currency: player.earlierCurrency }));
    const later = withoutNetwork(player.deposit({ currency: player.currency }));

    for (const event of [earlier, later, earlier, later]) {
      expect((await deliver(event)).status).toBe(200);
    }

    for (const [event, currency] of [
      [earlier, player.earlierCurrency],
      [later, player.currency],
    ] as const) {
      const ledger = await ledgerRows(event.externalId);
      expect(ledger.map((row) => row.currency)).toEqual([currency]);
      expect(await findings(event.externalId)).toHaveLength(0);
      expect(await balanceOf(player.userId, currency)).toBe(Number(FLOOR));
    }
  });

  it('audits a status event of either currency', async () => {
    const player = await twoCurrencies();
    const earlier = withoutNetwork(player.status('detected', { currency: player.earlierCurrency }));
    const later = withoutNetwork(player.status('failed', { currency: player.currency }));

    await deliver(earlier);
    await deliver(later);

    expect(await auditTrail(earlier.externalId)).toEqual(['detected']);
    expect(await auditTrail(later.externalId)).toEqual(['failed']);
  });

  it('refuses a below-minimum deposit of either currency on the webhook and on the poll', async () => {
    const player = await twoCurrencies();
    const events = [player.earlierCurrency, player.currency].flatMap((currency) =>
      [false, true].map((polled) => ({
        polled,
        event: withoutNetwork(player.deposit({ currency, amount: BELOW_FLOOR })),
      })),
    );

    for (const { polled, event } of events) {
      if (polled) {
        await reconcile([event]);
      } else {
        await deliver(event);
      }
    }

    for (const { event } of events) {
      expect(await kinds(event.externalId)).toEqual(['below_minimum_deposit']);
      expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
      expect(await ledgerRows(event.externalId)).toHaveLength(0);
    }
  });

  it('files a currency mismatch for a currency with no row, and credits nothing', async () => {
    const player = await twoCurrencies();
    const event = withoutNetwork(player.deposit({ currency: 'ZZZ' }));

    await deliver(event);

    expect(await kinds(event.externalId)).toEqual(['currency_mismatch']);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });

  it('credits the event currency, not the other row, when the event names the network', async () => {
    const player = await twoCurrencies();
    const event = player.deposit({ currency: player.currency, network: NETWORK });

    expect((await deliver(event)).status).toBe(200);

    expect((await ledgerRows(event.externalId)).map((row) => row.currency)).toEqual([
      player.currency,
    ]);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
    expect(await balanceOf(player.userId, player.earlierCurrency)).toBe(0);
  });

  it('records one ledger row for a webhook racing the poll on the later currency', async () => {
    const player = await twoCurrencies();
    const event = withoutNetwork(player.deposit({ currency: player.currency }));

    await Promise.all([deliver(event), deliver(event), reconcile([event])]);

    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
  });
});

describe('an address string held by two owners', () => {
  it('throws on a deposit and writes nothing', async () => {
    const owner = await setup();
    const other = await setup();
    await drizzle()
      .update(walletDepositAddress)
      .set({ address: owner.address })
      .where(eq(walletDepositAddress.userId, other.userId));
    const event = withoutNetwork(owner.deposit());

    const res = await deliver(event);

    expect(res.status).toBe(500);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await findings(event.externalId)).toHaveLength(0);
    expect(await guardRows(event.externalId)).toHaveLength(0);
    expect(await balanceOf(owner.userId, owner.currency)).toBe(0);
    expect(await balanceOf(other.userId, other.currency)).toBe(0);
  });
});

describe('a status event on an address issued on two networks', () => {
  it.each(['detected', 'failed'] as const)(
    'records no network on the %s audit row when none is named',
    async (kind) => {
      const player = await addressOnTwoNetworks();
      const event = withoutNetwork(player.status(kind));

      await deliver(event);

      const [audit] = await auditRows(event.externalId);
      expect(audit?.after).toMatchObject({ network: null });
    },
  );
});

describe('more polled amounts that cannot be read', () => {
  it.each([
    { label: 'blank', amount: '' },
    { label: 'negative', amount: '-5' },
    { label: 'very long', amount: 'x'.repeat(5000) },
  ])(
    'files one missing_deposit with no amount for a $label amount, and a repeat adds nothing',
    async ({ amount }) => {
      const player = await setup();
      const event = player.deposit({ amount });

      const run = await reconcile([event]);
      await reconcile([event]);

      expect(run.status).toBe('completed');
      const filed = await findings(event.externalId);
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatchObject({ kind: 'missing_deposit', amount: null, status: 'open' });
      expect(filed[0]?.detail).toContain(amount);
    },
  );

  it('cannot be refunded or credited, moves no money, and can be dismissed', async () => {
    const player = await setup();
    const event = player.deposit({ amount: 'abc' });
    await reconcile([event]);
    const [finding] = await findings(event.externalId);

    const refund = await resolve(finding!.id, {
      outcome: 'refunded',
      amount: FLOOR,
      txHash: 'tx-1',
      destinationAddress: 'dest-1',
    });
    const credit = await resolve(finding!.id, { outcome: 'credited' });

    expect(refund.status).toBe(409);
    expect(credit.status).toBe(409);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await balanceOf(player.userId, player.currency)).toBe(0);

    const dismiss = await resolve(finding!.id, { outcome: 'dismissed', note: 'unreadable' });

    expect(dismiss.status).toBe(200);
    expect((await findings(event.externalId))[0]?.status).toBe('resolved');
  });

  it('moves no money when an already credited id is re-reported unreadable', async () => {
    const player = await setup();
    const event = player.deposit();
    await deliver(event);

    await reconcile([{ ...event, amount: 'abc' }]);

    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
    const filed = await findings(event.externalId);
    expect(filed.map((finding) => finding.amount)).toEqual([null]);
    const [finding] = filed;
    const credit = await resolve(finding!.id, { outcome: 'credited' });
    expect(credit.status).toBe(409);
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
  });
});

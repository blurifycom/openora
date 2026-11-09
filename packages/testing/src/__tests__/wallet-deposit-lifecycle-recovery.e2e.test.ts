import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog } from '@openora/core/audit/schema';
import { walletDepositAddress } from '@openora/core/wallet/schema';
import {
  BELOW_FLOOR,
  bootDepositLifecycle,
  FLOOR,
  NETWORK,
  OTHER_NETWORK,
  withoutNetwork,
  type DepositEvent,
  type DepositPlayer,
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
    expect(await guardRows(earlier.externalId)).toHaveLength(1);
    expect(await guardRows(later.externalId)).toHaveLength(1);
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

describe('a polled deposit whose amount cannot be read', () => {
  it.each([
    { label: 'text', amount: 'abc' },
    { label: 'over-scale', amount: '15.0000000000000000001' },
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
      expect(filed[0]?.detail).toContain(JSON.stringify(amount).slice(0, 200));
      expect(filed[0]?.detail?.length).toBeLessThan(260);
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

  it('files and counts nothing when an already credited id is re-reported unreadable', async () => {
    const player = await setup();
    const event = player.deposit();
    await deliver(event);

    const run = await reconcile([{ ...event, amount: 'abc' }]);

    expect(run.summary).toMatchObject({ missingDeposit: 0 });
    expect(await findings(event.externalId)).toHaveLength(0);
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
  });

  it('files and counts nothing when a refused id is re-reported unreadable', async () => {
    const player = await setup();
    const event = player.deposit({ amount: BELOW_FLOOR });
    await deliver(event);

    const run = await reconcile([{ ...event, amount: 'abc' }]);

    expect(run.summary).toMatchObject({ missingDeposit: 0 });
    expect(await kinds(event.externalId)).toEqual(['below_minimum_deposit']);
  });
});

describe('a readable report of a deposit first seen with an unreadable amount', () => {
  const filledAudits = (findingId: string) =>
    drizzle()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'wallet.reconciliation_finding.filled'),
          eq(auditLog.resourceId, findingId),
        ),
      );

  async function reportedUnreadable(player: DepositPlayer, overrides: Partial<DepositEvent> = {}) {
    const event = player.deposit(overrides);
    await reconcile([{ ...event, amount: 'abc' }]);
    const [finding] = await findings(event.externalId);
    expect(finding).toMatchObject({ kind: 'missing_deposit', amount: null });
    return { event, findingId: finding!.id };
  }

  const refund = (id: string, amount: string) =>
    resolve(id, {
      outcome: 'refunded',
      amount,
      txHash: `refund-${randomUUID()}`,
      destinationAddress: `dest-${randomUUID()}`,
    });

  it('fills the open finding from the poll, with one audit row of both amounts', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);

    await reconcile([event]);

    const [filled] = await findings(event.externalId);
    expect(await kinds(event.externalId)).toEqual(['missing_deposit']);
    expect(filled).toMatchObject({ status: 'open', txHash: event.txHash, detail: null });
    expect(Number(filled?.amount)).toBe(Number(FLOOR));
    const audits = await filledAudits(findingId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.before).toMatchObject({ amount: null });
    expect(audits[0]?.after).toMatchObject({ amount: FLOOR });
  });

  it('credits the reported amount once through the admin route', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);
    await reconcile([event]);

    const first = await resolve(findingId, { outcome: 'credited' });
    const second = await resolve(findingId, { outcome: 'credited' });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
  });

  it('refunds the reported amount once through the admin route', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);
    await reconcile([event]);

    const first = await refund(findingId, FLOOR);
    const second = await refund(findingId, FLOOR);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await ledgerRows(event.externalId)).map((row) => row.status)).toEqual(['refunded']);
    expect(await balanceOf(player.userId, player.currency)).toBe(0);
  });

  it('fills from an unattributed webhook that the open finding suppresses', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `unknown-${randomUUID()}`,
    });

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await kinds(event.externalId)).toEqual(['missing_deposit']);
    const [filled] = await findings(event.externalId);
    expect(Number(filled?.amount)).toBe(Number(FLOOR));

    const credit = await resolve(findingId, { outcome: 'credited', userId: player.userId });

    expect(credit.status).toBe(200);
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
  });

  it('cannot pay again after a webhook to a known address credited an unfilled finding', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);

    expect((await deliver(event)).status).toBe(200);
    const credit = await resolve(findingId, { outcome: 'credited' });

    expect(credit.ok).toBe(false);
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
  });

  it('cannot pay again after a webhook to a known address credited a filled finding', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);
    await reconcile([event]);

    expect((await deliver(event)).status).toBe(200);
    const credit = await resolve(findingId, { outcome: 'credited' });

    expect(credit.ok).toBe(false);
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
  });

  it.each([
    { path: 'poll', report: (event: DepositEvent) => reconcile([event]) },
    { path: 'webhook', report: (event: DepositEvent) => deliver(event) },
  ])(
    'leaves no payable amount from a report below the minimum on the $path',
    async ({ report }) => {
      const player = await setup();
      const { event, findingId } = await reportedUnreadable(player);

      await report({ ...event, amount: BELOW_FLOOR });

      expect((await kinds(event.externalId)).sort()).toEqual([
        'below_minimum_deposit',
        'missing_deposit',
      ]);
      const [unreadable] = (await findings(event.externalId)).filter(
        (finding) => finding.kind === 'missing_deposit',
      );
      expect(unreadable?.amount).toBeNull();
      expect((await resolve(findingId, { outcome: 'credited' })).status).toBe(409);
      expect(await filledAudits(findingId)).toHaveLength(0);
      expect(await ledgerRows(event.externalId)).toHaveLength(0);
    },
  );

  it('rolls the fill back with a forced audit failure, and the retry fills', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `unknown-${randomUUID()}`,
    });
    const failAudit = `fail_audit_${randomUUID().replaceAll('-', '')}`;
    await drizzle().execute(
      sql.raw(`create function ${failAudit}() returns trigger language plpgsql as $$ begin
        if new.action = 'wallet.reconciliation_finding.filled' then
          raise exception 'forced audit failure';
        end if;
        return new;
      end $$`),
    );
    await drizzle().execute(
      sql.raw(
        `create trigger ${failAudit} before insert on audit_log for each row execute function ${failAudit}()`,
      ),
    );
    try {
      expect((await deliver(event)).ok).toBe(false);
      const [unfilled] = await findings(event.externalId);
      expect(unfilled?.amount).toBeNull();
      expect(unfilled?.detail).toContain('abc');
    } finally {
      await drizzle().execute(sql.raw(`drop trigger ${failAudit} on audit_log`));
      await drizzle().execute(sql.raw(`drop function ${failAudit}()`));
    }

    expect((await deliver(event)).status).toBe(200);

    expect(Number((await findings(event.externalId))[0]?.amount)).toBe(Number(FLOOR));
    expect(await filledAudits(findingId)).toHaveLength(1);
  });

  it('changes nothing and audits nothing on a repeat report, even of another amount', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);
    await reconcile([event]);
    const [filled] = await findings(event.externalId);

    await reconcile([event]);
    await reconcile([{ ...event, amount: '99' }]);

    expect(await findings(event.externalId)).toEqual([filled]);
    expect(await filledAudits(findingId)).toHaveLength(1);
  });

  it('fills once when two readable reports race', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `unknown-${randomUUID()}`,
    });

    await Promise.all([deliver(event), deliver(event)]);

    expect(await filledAudits(findingId)).toHaveLength(1);
  });

  it('leaves a dismissed finding as a person closed it', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);
    await resolve(findingId, { outcome: 'dismissed', note: 'unreadable' });

    await reconcile([event]);

    const [closed] = await findings(event.externalId);
    expect(closed).toMatchObject({ status: 'resolved', amount: null });
    expect(await filledAudits(findingId)).toHaveLength(0);
  });
});

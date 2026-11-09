import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { IDENTITY_READER } from '@openora/core/contracts';
import { DRIZZLE, EVENT_BUS } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { AuditService } from '@openora/core/audit/server';
import { walletDepositAddress, walletJobRun } from '@openora/core/wallet/schema';
import { setTestPaymentTransactions } from '../test-payment-webhook-plugin.js';
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
  app,
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
  withFailingTrigger,
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

  it('files and audits an amount cut in the middle of an emoji on the first run', async () => {
    const player = await setup();
    const event = player.deposit({ amount: '\u{1F600}'.repeat(150) });

    const run = await reconcile([event]);

    expect(run.status).toBe('completed');
    const [finding, ...others] = await findings(event.externalId);
    expect(others).toHaveLength(0);
    const audits = await drizzle()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'wallet.reconciliation_finding.recorded'),
          eq(auditLog.resourceId, finding!.id),
        ),
      );
    expect(audits).toHaveLength(1);
  });

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

  it('audits the old and new value of every field the fill overwrites', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `first-${randomUUID()}`,
      tag: 'tag-first',
      sourceAddress: 'source-first',
    });
    const readable = {
      ...event,
      currency: 'ZZZ',
      network: OTHER_NETWORK,
      address: `second-${randomUUID()}`,
      tag: 'tag-second',
      txHash: `hash-${randomUUID()}`,
      sourceAddress: 'source-second',
    };

    await deliver(readable);

    const [audit] = await filledAudits(findingId);
    expect(audit?.before).toEqual({
      amount: null,
      currency: event.currency,
      network: event.network,
      detail: expect.stringContaining('abc'),
    });
    expect(audit?.after).toMatchObject({
      amount: FLOOR,
      currency: 'ZZZ',
      network: OTHER_NETWORK,
      detail: null,
    });
    for (const identifier of ['address', 'tag', 'txHash', 'sourceAddress']) {
      expect(audit?.before).not.toHaveProperty(identifier);
      expect(audit?.after).not.toHaveProperty(identifier);
    }
  });

  it('leaves the incoming report’s kind and run out of a webhook fill’s audit row', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `unknown-${randomUUID()}`,
    });

    await deliver(event);

    expect(await kinds(event.externalId)).toEqual(['missing_deposit']);
    const [audit] = await filledAudits(findingId);
    expect(audit?.after).not.toHaveProperty('kind');
    expect(audit?.after).not.toHaveProperty('runId');
  });

  it.each([
    { changed: false, reportedAt: (first: string) => first },
    { changed: true, reportedAt: () => `second-${randomUUID()}` },
  ])('records addressChanged $changed, and never the address', async ({ changed, reportedAt }) => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `first-${randomUUID()}`,
    });
    const address = reportedAt(event.address);

    await deliver({ ...event, address });

    const [audit] = await filledAudits(findingId);
    expect(audit?.after).toMatchObject({ addressChanged: changed });
    expect(JSON.stringify([audit?.before, audit?.after])).not.toContain(event.address);
    expect(JSON.stringify([audit?.before, audit?.after])).not.toContain(address);
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
    await withFailingTrigger(
      { table: 'audit_log', when: "new.action = 'wallet.reconciliation_finding.filled'" },
      async () => {
        expect((await deliver(event)).ok).toBe(false);
        const [unfilled] = await findings(event.externalId);
        expect(unfilled?.amount).toBeNull();
        expect(unfilled?.detail).toContain('abc');
      },
    );

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

  it('writes every field of the readable report over the unreadable one', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `unknown-${randomUUID()}`,
      txHash: 'first-hash',
      sourceAddress: 'first-source',
    });
    const readable = {
      ...event,
      address: `unknown-${randomUUID()}`,
      tag: 'memo-2',
      txHash: 'second-hash',
      sourceAddress: 'second-source',
    };

    await deliver(readable);

    const [filled] = await findings(event.externalId);
    expect(filled).toMatchObject({
      kind: 'missing_deposit',
      status: 'open',
      currency: readable.currency,
      network: readable.network,
      address: readable.address,
      tag: 'memo-2',
      txHash: 'second-hash',
      sourceAddress: 'second-source',
      detail: null,
    });
    expect(Number(filled?.amount)).toBe(Number(FLOOR));
    const [audit, ...rest] = await filledAudits(findingId);
    expect(rest).toHaveLength(0);
    expect(audit).toMatchObject({
      actorType: 'system',
      resourceType: 'wallet_reconciliation_finding',
    });
    expect(audit?.before).toMatchObject({ amount: null });
    expect(audit?.after).toMatchObject({ amount: FLOOR, currency: readable.currency });
  });

  it('asks an admin to name the player after a fill at an unknown address', async () => {
    const player = await setup();
    const other = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `unknown-${randomUUID()}`,
    });
    await deliver(event);

    const unnamed = await resolve(findingId, { outcome: 'credited' });
    const ghost = await resolve(findingId, { outcome: 'credited', userId: randomUUID() });

    expect([unnamed.status, ghost.status]).toEqual([409, 404]);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);

    const named = await resolve(findingId, { outcome: 'credited', userId: other.userId });

    expect(named.status).toBe(200);
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await balanceOf(other.userId, player.currency)).toBe(Number(FLOOR));
    expect(await balanceOf(player.userId, player.currency)).toBe(0);
  });

  it('refuses to credit another player than the owner of the address it was filled with', async () => {
    const player = await setup();
    const other = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `unknown-${randomUUID()}`,
    });
    await reconcile([{ ...event, address: player.address }]);

    const wrong = await resolve(findingId, { outcome: 'credited', userId: other.userId });

    expect(wrong.status).toBe(409);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect((await resolve(findingId, { outcome: 'credited' })).status).toBe(200);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
    expect(await balanceOf(other.userId, player.currency)).toBe(0);
  });

  it('fills a zero amount reported for an unknown address, which can then only be dismissed', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `unknown-${randomUUID()}`,
    });

    await deliver({ ...event, amount: '0' });

    expect(Number((await findings(event.externalId))[0]?.amount)).toBe(0);
    expect((await resolve(findingId, { outcome: 'credited', userId: player.userId })).status).toBe(
      409,
    );
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect((await resolve(findingId, { outcome: 'dismissed', note: 'zero' })).status).toBe(200);
  });

  it('does not fill a finding an admin already credited, whatever amount is reported next', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);
    await reconcile([event]);
    expect((await resolve(findingId, { outcome: 'credited' })).status).toBe(200);

    await reconcile([{ ...event, amount: '99' }]);

    const [closed] = await findings(event.externalId);
    expect(closed).toMatchObject({ status: 'resolved' });
    expect(Number(closed?.amount)).toBe(Number(FLOOR));
    expect(await filledAudits(findingId)).toHaveLength(1);
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
  });

  it('does not fill once the deposit id was refunded from a finding of another kind', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);
    await deliver({ ...event, amount: BELOW_FLOOR });
    const [refusal] = (await findings(event.externalId)).filter(
      (finding) => finding.kind === 'below_minimum_deposit',
    );
    expect((await refund(refusal!.id, BELOW_FLOOR)).status).toBe(200);
    const elsewhere = { ...event, address: `unknown-${randomUUID()}` };

    expect((await deliver(elsewhere)).status).toBe(200);
    await reconcile([elsewhere]);

    const [unreadable] = (await findings(event.externalId)).filter(
      (finding) => finding.kind === 'missing_deposit',
    );
    expect(unreadable).toMatchObject({ id: findingId, status: 'open', amount: null });
    expect(await filledAudits(findingId)).toHaveLength(0);
    expect((await resolve(findingId, { outcome: 'credited', userId: player.userId })).status).toBe(
      409,
    );
    expect((await ledgerRows(event.externalId)).map((row) => row.status)).toEqual(['refunded']);
    expect(await balanceOf(player.userId, player.currency)).toBe(0);
  });

  it('rolls a polled fill back with a forced audit failure, and the next run fills', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);
    await withFailingTrigger(
      { table: 'audit_log', when: "new.action = 'wallet.reconciliation_finding.filled'" },
      async () => {
        setTestPaymentTransactions([event]);
        const started = await adminClient().post('/wallet/reconciliation/run', {});
        const { runId } = (await started.json()) as { runId: string };
        await vi.waitFor(
          async () => {
            const [run] = await drizzle()
              .select({ status: walletJobRun.status })
              .from(walletJobRun)
              .where(eq(walletJobRun.runId, runId));
            expect(run?.status).toBe('failed');
          },
          { timeout: 20_000, interval: 100 },
        );
        expect((await findings(event.externalId))[0]?.amount).toBeNull();
      },
    );

    const retried = await reconcile([event]);

    expect(retried.status).toBe('completed');
    expect(Number((await findings(event.externalId))[0]?.amount)).toBe(Number(FLOOR));
    expect(await filledAudits(findingId)).toHaveLength(1);
  });

  it.each(['credited', 'refunded', 'dismissed'] as const)(
    'settles one outcome when a readable report races a %s resolution',
    async (outcome) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const player = await setup();
        const { event, findingId } = await reportedUnreadable(player);
        const resolution =
          outcome === 'credited'
            ? resolve(findingId, { outcome })
            : outcome === 'refunded'
              ? refund(findingId, FLOOR)
              : resolve(findingId, { outcome, note: 'raced' });

        await Promise.all([resolution, reconcile([event])]);

        const [finding] = await findings(event.externalId);
        const ledger = await ledgerRows(event.externalId);
        expect(await filledAudits(findingId)).toHaveLength(finding?.amount === null ? 0 : 1);
        expect(ledger.length).toBe(
          finding?.status === 'resolved' && outcome !== 'dismissed' ? 1 : 0,
        );
        expect(await balanceOf(player.userId, player.currency)).toBe(
          ledger.some((row) => row.status === 'completed') ? Number(FLOOR) : 0,
        );
      }
    },
  );

  it('moves the money once when a credit races a refund of a filled finding', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const player = await setup();
      const { event, findingId } = await reportedUnreadable(player);
      await reconcile([event]);

      await Promise.all([resolve(findingId, { outcome: 'credited' }), refund(findingId, FLOOR)]);

      const ledger = await ledgerRows(event.externalId);
      expect(ledger).toHaveLength(1);
      expect((await findings(event.externalId))[0]?.status).toBe('resolved');
      expect(await balanceOf(player.userId, player.currency)).toBe(
        ledger[0]?.status === 'completed' ? Number(FLOOR) : 0,
      );
    }
  });

  it('serves one fill on the audit route with no chain identifier, and the chain verifies', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player, {
      address: `first-${randomUUID()}`,
      tag: 'tag-first',
      sourceAddress: 'source-first',
    });
    const readable = {
      ...event,
      currency: 'ZZZ',
      network: OTHER_NETWORK,
      address: `second-${randomUUID()}`,
      tag: 'tag-second',
      txHash: `hash-${randomUUID()}`,
      sourceAddress: 'source-second',
    };
    await deliver(readable);

    const res = await adminClient().get(
      `/audit/logs?resourceId=${findingId}&action=wallet.reconciliation_finding.filled&limit=50`,
    );

    const { items } = (await res.json()) as {
      items: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }>;
    };
    expect(items).toHaveLength(1);
    const logged = JSON.stringify(items);
    for (const identifier of [
      readable.address,
      readable.txHash,
      'tag-second',
      'source-second',
      'tag-first',
      'source-first',
      event.address,
    ]) {
      expect(logged).not.toContain(identifier);
    }
    const audit = new AuditService(
      app().container.get(DRIZZLE),
      app().container.get(EVENT_BUS),
      app().container.get(IDENTITY_READER),
    );
    expect(await audit.verifyChain()).toEqual({ valid: true });
  });

  it('fills once when a poll and two webhooks report the same deposit at once', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const player = await setup();
      const { event, findingId } = await reportedUnreadable(player, {
        address: `unknown-${randomUUID()}`,
      });

      await Promise.all([reconcile([event]), deliver(event), deliver(event)]);

      expect(await filledAudits(findingId)).toHaveLength(1);
      expect(Number((await findings(event.externalId))[0]?.amount)).toBe(Number(FLOOR));
      expect(await ledgerRows(event.externalId)).toHaveLength(0);
    }
  });

  it('shows the fill through the audit read route and keeps the hash chain valid', async () => {
    const player = await setup();
    const { event, findingId } = await reportedUnreadable(player);
    await reconcile([event]);

    const res = await adminClient().get(
      `/audit/logs?resourceId=${findingId}&action=wallet.reconciliation_finding.filled&limit=50`,
    );

    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: Array<{ action: string; before: unknown; after: unknown }>;
    };
    expect(items).toHaveLength(1);
    expect(items[0]?.before).toMatchObject({ amount: null });
    expect(items[0]?.after).toMatchObject({ amount: FLOOR });
    const audit = new AuditService(
      app().container.get(DRIZZLE),
      app().container.get(EVENT_BUS),
      app().container.get(IDENTITY_READER),
    );
    expect(await audit.verifyChain()).toEqual({ valid: true });
  });
});

describe('a polled deposit or event that is skipped, not filed', () => {
  it('files nothing for a blank id on a polled deposit', async () => {
    const player = await setup();
    const before = (await findings('')).length;

    const run = await reconcile([player.deposit({ amount: 'abc', externalId: '' })]);

    expect(run.status).toBe('completed');
    expect(await findings('')).toHaveLength(before);
  });

  it('files nothing and records no refusal for a malformed polled status event', async () => {
    const player = await setup();
    const event = player.status('detected', { amount: 'abc' });

    const run = await reconcile([event]);

    expect(run.status).toBe('completed');
    expect(await findings(event.externalId)).toHaveLength(0);
    expect(await guardRows(event.externalId)).toHaveLength(0);
  });

  it('answers an error on the webhook for an unreadable amount, and files nothing', async () => {
    const player = await setup();
    const event = player.deposit({ amount: 'abc' });

    const res = await deliver(event);

    expect(res.status).toBe(500);
    expect(await findings(event.externalId)).toHaveLength(0);
  });

  it('files nothing for a refunded id without a ledger row that is re-reported unreadable', async () => {
    const player = await setup();
    const event = player.deposit({ address: `unknown-${randomUUID()}` });
    await reconcile([event]);
    const [finding] = await findings(event.externalId);
    expect(
      (
        await resolve(finding!.id, {
          outcome: 'refunded',
          amount: FLOOR,
          txHash: `refund-${randomUUID()}`,
          destinationAddress: `dest-${randomUUID()}`,
        })
      ).status,
    ).toBe(200);

    await reconcile([{ ...event, amount: 'abc' }]);

    expect(await findings(event.externalId)).toHaveLength(1);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });
});

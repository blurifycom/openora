import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_PAYMENT_PROVIDER } from '@openora/core/contracts';
import {
  wallet,
  walletAsset,
  walletRefundedDeposit,
  walletTransaction,
} from '@openora/core/wallet/schema';
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
  app,
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
    // The audit subscriber turns that event into a row of its own, beside the failed one.
    await vi.waitFor(
      async () => {
        const completed = await drizzle().execute(
          sql`select count(*)::int as n from audit_log where action = 'wallet.deposit.completed' and after::text like ${`%${credit!.id}%`}`,
        );
        expect(completed.rows[0]?.['n']).toBe(1);
      },
      { timeout: 15_000, interval: 250 },
    );
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

const resolveFinding = (id: string, resolution: Record<string, string>) =>
  adminClient().post(`/wallet/reconciliation/${id}/resolve`, { resolution });

const refundOf = (amount: string) => ({
  outcome: 'refunded',
  amount,
  txHash: `refund-${randomUUID()}`,
  destinationAddress: `dest-${randomUUID()}`,
});

const onlyFinding = async (externalId: string) => {
  const [finding, ...rest] = await findings(externalId);
  expect(rest).toHaveLength(0);
  return finding!;
};

const refundedMarks = (externalId: string) =>
  drizzle()
    .select()
    .from(walletRefundedDeposit)
    .where(eq(walletRefundedDeposit.externalId, externalId));

describe('a refused deposit seen by the poll and by the webhook, in either order', () => {
  it.each([
    { first: 'poll', then: 'webhook' },
    { first: 'webhook', then: 'poll' },
  ] as const)('leaves one finding and one audit row, $first first', async ({ first }) => {
    const tag = `tag-${randomUUID()}`;
    const player = await setup({ tag });
    const event = player.deposit({
      tag,
      amount: BELOW_FLOOR,
      sourceAddress: `src-${randomUUID()}`,
    });
    const viaPoll = () => reconcile([event]);
    const viaWebhook = () => deliver(event);
    const [one, two] = first === 'poll' ? [viaPoll, viaWebhook] : [viaWebhook, viaPoll];

    await one();
    await two();
    await one();
    await two();

    const filed = await findings(event.externalId);
    expect(filed.map((finding) => finding.kind)).toEqual(['below_minimum_deposit']);
    expect(filed[0]).toMatchObject({
      status: 'open',
      address: player.address,
      tag,
      txHash: event.txHash,
      sourceAddress: event.sourceAddress,
    });
    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
    expect(await guardRows(event.externalId)).toHaveLength(1);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });
});

describe('a refusal and its finding', () => {
  it('commit together: a finding that cannot be written leaves no refusal, and the retry writes both', async () => {
    const player = await setup();
    const event = player.deposit({ amount: BELOW_FLOOR });
    const failFinding = `fail_finding_${randomUUID().replaceAll('-', '')}`;
    await drizzle().execute(
      sql.raw(`create function ${failFinding}() returns trigger language plpgsql as $$ begin
        if new.kind = 'below_minimum_deposit' then
          raise exception 'forced finding failure';
        end if;
        return new;
      end $$`),
    );
    await drizzle().execute(
      sql.raw(
        `create trigger ${failFinding} before insert on wallet_reconciliation_finding for each row execute function ${failFinding}()`,
      ),
    );
    try {
      const refused = await deliver(event);

      expect(refused.ok).toBe(false);
      expect(await guardRows(event.externalId)).toHaveLength(0);
      expect(await auditRows(event.externalId)).toHaveLength(0);
      expect(await findings(event.externalId)).toHaveLength(0);
    } finally {
      await drizzle().execute(
        sql.raw(`drop trigger ${failFinding} on wallet_reconciliation_finding`),
      );
      await drizzle().execute(sql.raw(`drop function ${failFinding}()`));
    }

    const retried = await deliver(event);

    expect(retried.status).toBe(200);
    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
    expect((await findings(event.externalId)).map((finding) => finding.kind)).toEqual([
      'below_minimum_deposit',
    ]);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });
});

describe('resolving a refused deposit', () => {
  it('pays once however often it is credited, and a refund afterwards moves nothing', async () => {
    const player = await setup();
    const event = player.deposit({ amount: BELOW_FLOOR });
    await deliver(event);
    const { id } = await onlyFinding(event.externalId);

    const responses = [
      await resolveFinding(id, { outcome: 'credited' }),
      await resolveFinding(id, { outcome: 'credited' }),
      await resolveFinding(id, refundOf(BELOW_FLOOR)),
    ];
    await deliver(event);
    await reconcile([event]);

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
    expect((await ledgerRows(event.externalId)).map((row) => row.status)).toEqual(['completed']);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(BELOW_FLOOR));
    expect(await refundedMarks(event.externalId)).toHaveLength(0);
    expect((await onlyFinding(event.externalId)).status).toBe('resolved');
  });

  it('refunds once however often it is asked, and a credit afterwards pays nothing', async () => {
    const player = await setup();
    const event = player.deposit({ amount: BELOW_FLOOR });
    await deliver(event);
    const { id } = await onlyFinding(event.externalId);

    await resolveFinding(id, refundOf(BELOW_FLOOR));
    await resolveFinding(id, refundOf(BELOW_FLOOR));
    await resolveFinding(id, { outcome: 'credited' });
    await deliver(event);
    await reconcile([event]);

    expect((await ledgerRows(event.externalId)).map((row) => row.status)).toEqual(['refunded']);
    expect(await balanceOf(player.userId, player.currency)).toBe(0);
    expect(await refundedMarks(event.externalId)).toHaveLength(1);
  });

  it('applies exactly one outcome when a credit races a refund', async () => {
    for (let round = 0; round < 3; round += 1) {
      const player = await setup();
      const event = player.deposit({ amount: BELOW_FLOOR });
      await deliver(event);
      const { id } = await onlyFinding(event.externalId);

      await Promise.all([
        resolveFinding(id, { outcome: 'credited' }),
        resolveFinding(id, refundOf(BELOW_FLOOR)),
      ]);
      await deliver(event);

      const [row, ...rest] = await ledgerRows(event.externalId);
      expect(rest).toHaveLength(0);
      const credited = row?.status === 'completed';
      expect(await balanceOf(player.userId, player.currency)).toBe(
        credited ? Number(BELOW_FLOOR) : 0,
      );
      expect((await refundedMarks(event.externalId)).length).toBe(credited ? 0 : 1);
      expect(credited || row?.status === 'refunded').toBe(true);
    }
  });

  it('keeps a dismissed deposit unpaid when it is redelivered or polled', async () => {
    const player = await setup();
    const event = player.deposit({ amount: BELOW_FLOOR });
    await deliver(event);
    const { id } = await onlyFinding(event.externalId);

    const res = await resolveFinding(id, { outcome: 'dismissed', note: 'not ours' });
    await deliver(event);
    await reconcile([event]);

    expect(res.status).toBe(200);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect(await balanceOf(player.userId, player.currency)).toBe(0);
    expect((await findings(event.externalId)).map((finding) => finding.status)).toEqual([
      'resolved',
    ]);
  });

  it('is closed to a player and to a caller with no session', async () => {
    const player = await setup();
    const event = player.deposit({ amount: BELOW_FLOOR });
    await deliver(event);
    const { id } = await onlyFinding(event.externalId);

    const asPlayer = await player.client.post(`/wallet/reconciliation/${id}/resolve`, {
      resolution: { outcome: 'credited' },
    });
    const anonymous = await app().app.request(`/wallet/reconciliation/${id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolution: { outcome: 'credited' } }),
    });

    expect([asPlayer.status, anonymous.status]).toEqual([403, 401]);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
    expect((await onlyFinding(event.externalId)).status).toBe('open');
  });
});

describe('the open findings the alert counts', () => {
  it('count every other kind, and leave out only a refused deposit', async () => {
    const player = await setup();
    const openFindings = async () => (await reconcile([])).summary?.['openFindings'] as number;
    const start = await openFindings();

    await deliver(player.deposit({ amount: BELOW_FLOOR }));
    const afterRefused = await openFindings();
    await deliver(player.deposit({ address: `unknown-${randomUUID()}` }));
    const afterUnattributed = await openFindings();
    await reconcile([player.deposit()]);
    const afterMissing = await openFindings();

    expect([afterRefused, afterUnattributed, afterMissing]).toEqual([start, start + 1, start + 2]);
  });
});

describe('the poll, with malformed events beside valid ones', () => {
  it('processes every valid event of the run and files nothing for the malformed ones', async () => {
    const player = await setup();
    const malformedDeposit = player.deposit({ amount: 'abc' });
    const noId = player.deposit({ externalId: '' });
    const malformedStatus = player.status('failed', { amount: '-1' });
    const refused = player.deposit({ amount: BELOW_FLOOR });
    const missing = player.deposit();
    const status = player.status('detected');

    const run = await reconcile([
      malformedDeposit,
      noId,
      malformedStatus,
      refused,
      missing,
      status,
    ]);

    expect(run.status).toBe('completed');
    for (const { externalId } of [malformedDeposit, malformedStatus]) {
      expect(await findings(externalId)).toHaveLength(0);
      expect(await guardRows(externalId)).toHaveLength(0);
    }
    expect(await findings('')).toHaveLength(0);
    expect((await findings(refused.externalId)).map((finding) => finding.kind)).toEqual([
      'below_minimum_deposit',
    ]);
    expect((await findings(missing.externalId)).map((finding) => finding.kind)).toEqual([
      'missing_deposit',
    ]);
    expect(await auditTrail(status.externalId)).toEqual(['detected']);
  });
});

describe('the poll over more events than one lookup chunk', () => {
  it('records only the new ones, and a second identical run writes nothing', async () => {
    const player = await setup();
    const credited = player.deposit();
    await deliver(credited);
    const refused = player.deposit({ amount: BELOW_FLOOR });
    await deliver(refused);
    const seen = player.status('detected');
    await deliver(seen);
    const [record] = await drizzle()
      .select({ id: wallet.id })
      .from(wallet)
      .where(eq(wallet.userId, player.userId));
    // Matching ledger rows push the events below past the first 1000-id lookup chunk.
    const fillers = Array.from({ length: 1005 }, () =>
      player.deposit({ externalId: `filler-${randomUUID()}` }),
    );
    for (let from = 0; from < fillers.length; from += 500) {
      await drizzle()
        .insert(walletTransaction)
        .values(
          fillers.slice(from, from + 500).map((filler) => ({
            walletId: record!.id,
            type: 'deposit' as const,
            amount: FLOOR,
            currency: player.currency,
            status: 'completed' as const,
            direction: 'credit' as const,
            rail: 'crypto' as const,
            network: NETWORK,
            providerName: DEFAULT_PAYMENT_PROVIDER,
            providerRefId: filler.externalId,
          })),
        );
    }
    const newRefused = player.deposit({ amount: BELOW_FLOOR });
    const newMissing = player.deposit();
    const newStatus = player.status('failed');
    const events = [...fillers, credited, refused, newRefused, newMissing, seen, newStatus];
    const written = async () => ({
      findings: (
        await drizzle().execute(
          sql`select count(*)::int as n from wallet_reconciliation_finding where external_id is not null`,
        )
      ).rows[0]?.['n'],
      audit: (
        await drizzle().execute(
          sql`select count(*)::int as n from audit_log where action in ('wallet.deposit.detected', 'wallet.deposit.failed', 'wallet.deposit.below_minimum')`,
        )
      ).rows[0]?.['n'],
    });
    const before = await written();

    await reconcile(events);
    const afterFirst = await written();
    await reconcile(events);

    expect(afterFirst).toEqual({
      findings: Number(before.findings) + 2,
      audit: Number(before.audit) + 2,
    });
    expect(await written()).toEqual(afterFirst);
    expect((await findings(credited.externalId)).length).toBe(0);
    expect((await findings(refused.externalId)).map((finding) => finding.kind)).toEqual([
      'below_minimum_deposit',
    ]);
    expect((await findings(newMissing.externalId)).map((finding) => finding.kind)).toEqual([
      'missing_deposit',
    ]);
    expect(await auditTrail(newStatus.externalId)).toEqual(['failed']);
    expect(await auditTrail(seen.externalId)).toEqual(['detected']);
    expect(await ledgerRows(credited.externalId)).toHaveLength(1);
  });
});

describe('the asset catalog lock', () => {
  it('does not hold up a webhook deposit, and still holds up issuing an address', async () => {
    const player = await setup();
    const event = player.deposit();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolveLocked) => {
      locked = resolveLocked;
    });
    const holder = drizzle().transaction(async (tx) => {
      await tx
        .select()
        .from(walletAsset)
        .where(eq(walletAsset.currency, player.currency))
        .for('update');
      locked();
      await gate;
    });
    const later = (ms: number) =>
      new Promise<string>((resolveLater) => setTimeout(() => resolveLater('held up'), ms));
    try {
      await holding;

      const webhook = await Promise.race([
        Promise.resolve(deliver(event)).then((res) => res.status),
        later(10_000),
      ]);
      const issuing = issueAddress(player.client, player.currency, NETWORK).then(() => 'issued');
      const issuance = await Promise.race([issuing, later(1_500)]);

      expect(webhook).toBe(200);
      expect(await ledgerRows(event.externalId)).toHaveLength(1);
      expect(issuance).toBe('held up');
      release();
      expect(await issuing).toBe('issued');
    } finally {
      release();
      await holder;
    }
  });

  it('decides a deposit on the committed catalog while a change to it is in flight', async () => {
    const player = await setup();
    const event = player.deposit({ amount: FLOOR });
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let changed!: () => void;
    const changing = new Promise<void>((resolveChanged) => {
      changed = resolveChanged;
    });
    const holder = drizzle().transaction(async (tx) => {
      await tx
        .update(walletAsset)
        .set({ minDeposit: '100' })
        .where(eq(walletAsset.currency, player.currency));
      changed();
      await gate;
    });
    try {
      await changing;
      const res = await deliver(event);
      expect(res.status).toBe(200);
    } finally {
      release();
      await holder;
    }

    const redelivered = await deliver(event);

    expect(redelivered.status).toBe(200);
    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
    expect(await auditRows(event.externalId)).toHaveLength(0);
  });
});

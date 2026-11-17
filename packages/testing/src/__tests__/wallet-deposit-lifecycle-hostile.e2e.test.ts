import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { count, eq, inArray } from 'drizzle-orm';
import { DEFAULT_PAYMENT_PROVIDER, IDENTITY_READER } from '@openora/core/contracts';
import { DRIZZLE, EVENT_BUS } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { AuditService } from '@openora/core/audit/server';
import { walletDepositAddress, walletDepositStatusEvent } from '@openora/core/wallet/schema';
import {
  BELOW_FLOOR,
  bootDepositLifecycle,
  FLOOR,
  NETWORK,
  type DepositPlayer,
} from './fixtures/wallet-deposit-lifecycle.js';

const SECOND_VENDOR = 'second-vendor';

const {
  app,
  drizzle,
  setMinDeposit,
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

const LIFECYCLE_ACTIONS = [
  'wallet.deposit.detected',
  'wallet.deposit.failed',
  'wallet.deposit.below_minimum',
];

async function rowCounts() {
  const [guards] = await drizzle().select({ n: count() }).from(walletDepositStatusEvent);
  const [audits] = await drizzle()
    .select({ n: count() })
    .from(auditLog)
    .where(inArray(auditLog.action, LIFECYCLE_ACTIONS));
  return { guards: guards?.n, audits: audits?.n };
}

describe('a status event racing the confirmed deposit of the same transfer', () => {
  const ROUNDS = 3;

  async function race(make: (p: DepositPlayer) => [{ externalId: string }, unknown]) {
    const player = await setup();
    const [first, second] = make(player);
    const responses = await Promise.all([deliver(first), deliver(second)]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    return { player, externalId: first.externalId };
  }

  it('credits once whichever commits first, and audits the status only if it won the lock', async () => {
    const kinds: Array<'detected' | 'failed'> = ['detected', 'failed'];
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const kind of kinds) {
        const { player, externalId } = await race((p) => {
          const confirmed = p.deposit();
          return [p.status(kind, { externalId: confirmed.externalId }), confirmed];
        });
        expect(await ledgerRows(externalId)).toHaveLength(1);
        expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
        expect(await auditTrail(externalId)).toEqual(
          (await guardRows(externalId)).length === 1 ? [kind] : [],
        );
      }
    }
  });

  it('keeps detected before failed when the two race', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { externalId } = await race((p) => {
        const failed = p.status('failed');
        return [failed, { ...failed, status: 'detected' }];
      });
      const trail = await auditTrail(externalId);
      expect(['failed', 'detected,failed']).toContain(trail.join(','));
      expect(await guardRows(externalId)).toHaveLength(trail.length);
    }
  });

  it('never both credits and refuses one transfer when a below-minimum and an at-floor delivery race', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { player, externalId } = await race((p) => {
        const under = p.deposit({ amount: BELOW_FLOOR });
        return [under, { ...under, amount: FLOOR }];
      });
      const credited = (await ledgerRows(externalId)).length;
      const refused = (await auditTrail(externalId)).length;
      expect(credited + refused).toBe(1);
      expect(await balanceOf(player.userId, player.currency)).toBe(credited ? Number(FLOOR) : 0);
    }
  });

  it('audits failed before below_minimum, never after, when the two race', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { player, externalId } = await race((p) => {
        const under = p.deposit({ amount: BELOW_FLOOR });
        return [under, p.status('failed', { externalId: under.externalId })];
      });
      const trail = await auditTrail(externalId);
      expect(['below_minimum', 'failed,below_minimum']).toContain(trail.join(','));
      expect(await ledgerRows(externalId)).toHaveLength(0);
      expect(await balanceOf(player.userId, player.currency)).toBe(0);
    }
  });
});

describe('the same transfer id under two vendors', () => {
  it('keeps each vendor’s verdicts apart and credits each its own deposit', async () => {
    const first = await setup();
    const second = await setup();
    await drizzle()
      .update(walletDepositAddress)
      .set({ providerName: SECOND_VENDOR })
      .where(eq(walletDepositAddress.userId, second.userId));
    const externalId = randomUUID();

    for (const player of [first, second]) {
      await deliver(player.deposit({ externalId, amount: BELOW_FLOOR }));
      await deliver(player.status('detected', { externalId }));
    }

    expect(
      (await guardRows(externalId)).map((row) => `${row.providerName}/${row.status}`).sort(),
    ).toEqual(
      [`${DEFAULT_PAYMENT_PROVIDER}/below_minimum`, `${SECOND_VENDOR}/below_minimum`].sort(),
    );
    const audited = await auditRows(externalId);
    expect(audited.map((row) => row.resourceId).sort()).toEqual(
      [first.playerId, second.playerId].sort(),
    );
    expect(await ledgerRows(externalId)).toHaveLength(0);

    const sharedAtFloor = randomUUID();
    await deliver(first.deposit({ externalId: sharedAtFloor }));
    await deliver(second.deposit({ externalId: sharedAtFloor }));
    expect((await ledgerRows(sharedAtFloor)).map((row) => row.providerName).sort()).toEqual(
      [DEFAULT_PAYMENT_PROVIDER, SECOND_VENDOR].sort(),
    );
  });
});

describe('an amount the vendor should never send', () => {
  it.each(['', '-5', '1e3', 'abc', '0x1', '15.5.5', 'NaN'])(
    'answers an error, credits nothing and moves no balance for %j',
    async (amount) => {
      const player = await setup();
      const event = player.deposit({ amount });

      const responses = [await deliver(event), await deliver(event)];

      expect(responses.map((res) => res.status)).toEqual([500, 500]);
      expect(await ledgerRows(event.externalId)).toHaveLength(0);
      expect(await balanceOf(player.userId, player.currency)).toBe(0);
      expect(await findings(event.externalId)).toHaveLength(0);
    },
  );
});

describe('a status event the contract does not describe', () => {
  it.each([{ status: 'pending' }, { status: undefined }, { externalId: undefined }])(
    'answers an error and writes no guard or audit row for %j',
    async (override) => {
      const player = await setup();
      const before = await rowCounts();

      const res = await deliver({ ...player.status('detected'), ...override });

      expect(res.status).toBe(500);
      expect(await rowCounts()).toEqual(before);
      expect(await balanceOf(player.userId, player.currency)).toBe(0);
    },
  );
});

describe('currency and network casing', () => {
  it('finds the floor whatever the case of the currency the vendor reports', async () => {
    const player = await setup();
    const under = player.deposit({ amount: BELOW_FLOOR, currency: player.currency.toLowerCase() });
    const atFloor = player.deposit({ currency: player.currency.toLowerCase() });

    await deliver(under);
    await deliver(atFloor);

    expect(await auditTrail(under.externalId)).toEqual(['below_minimum']);
    expect(await ledgerRows(under.externalId)).toHaveLength(0);
    expect(await ledgerRows(atFloor.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
  });

  it('finds the floor whatever the case of the network the address was issued on', async () => {
    const player = await setup();
    await drizzle()
      .update(walletDepositAddress)
      .set({ network: NETWORK.toLowerCase() })
      .where(eq(walletDepositAddress.userId, player.userId));
    const { network: _network, ...event } = player.deposit({ amount: BELOW_FLOOR });

    await deliver(event);

    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });
});

describe('a floor of zero', () => {
  it('refuses nothing that is positive and still credits it', async () => {
    const player = await setup({ assets: [{ network: NETWORK, minDeposit: '0' }] });
    const event = player.deposit({ amount: '0.000000000000000001' });

    await deliver(event);

    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await auditTrail(event.externalId)).toEqual([]);
  });
});

describe('the guard row and the audit row', () => {
  it('commit together with the finding: a forced audit failure leaves none, and the retry writes all', async () => {
    const player = await setup();
    const failed = player.status('failed');
    const belowMinimum = player.deposit({ amount: BELOW_FLOOR });
    await withFailingTrigger(
      {
        table: 'audit_log',
        when: "new.action in ('wallet.deposit.failed', 'wallet.deposit.below_minimum')",
      },
      async () => {
        const refused = await Promise.all([deliver(failed), deliver(belowMinimum)]);
        expect(refused.map((res) => res.ok)).toEqual([false, false]);
        for (const { externalId } of [failed, belowMinimum]) {
          expect(await guardRows(externalId)).toHaveLength(0);
          expect(await auditRows(externalId)).toHaveLength(0);
          expect(await findings(externalId)).toHaveLength(0);
        }
        expect(await ledgerRows(belowMinimum.externalId)).toHaveLength(0);
      },
    );

    const retried = await Promise.all([deliver(failed), deliver(belowMinimum)]);

    expect(retried.map((res) => res.status)).toEqual([200, 200]);
    expect(await auditTrail(failed.externalId)).toEqual(['failed']);
    expect(await auditTrail(belowMinimum.externalId)).toEqual(['below_minimum']);
    expect(await guardRows(failed.externalId)).toHaveLength(1);
    expect(await guardRows(belowMinimum.externalId)).toHaveLength(1);
    expect(await findings(belowMinimum.externalId)).toHaveLength(1);
  });
});

describe('reconciliation, beyond a plain below-minimum deposit', () => {
  it('leaves a credited deposit alone when the minimum has since risen and a late failure is polled', async () => {
    const player = await setup();
    const credited = player.deposit();
    await deliver(credited);
    await setMinDeposit(player.currency, '100');

    await reconcile([credited, player.status('failed', { externalId: credited.externalId })]);

    expect(await ledgerRows(credited.externalId)).toHaveLength(1);
    expect(await findings(credited.externalId)).toHaveLength(0);
    expect(await auditRows(credited.externalId)).toHaveLength(0);
  });

  it('still files a finding for a below-minimum deposit no single player can be named for', async () => {
    const player = await setup();
    const unknownAddress = player.deposit({
      address: `unknown-${randomUUID()}`,
      amount: BELOW_FLOOR,
    });

    await reconcile([unknownAddress]);

    expect(await findings(unknownAddress.externalId)).toHaveLength(1);
    expect(await auditRows(unknownAddress.externalId)).toHaveLength(0);
    expect(await guardRows(unknownAddress.externalId)).toHaveLength(0);
  });

  it('settles a below-minimum deposit seen by the poll before the webhook with one audit row', async () => {
    const player = await setup();
    const event = player.deposit({ amount: BELOW_FLOOR });

    await reconcile([event]);
    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
    expect((await findings(event.externalId)).map((finding) => finding.kind)).toEqual([
      'below_minimum_deposit',
    ]);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });
});

describe('a malformed amount or id on an audited outcome', () => {
  it.each(['', '-5'])(
    'records no refusal for %j, so the real amount still credits',
    async (amount) => {
      const player = await setup();
      const externalId = randomUUID();

      const refused = await deliver(player.deposit({ externalId, amount }));

      expect(refused.status).toBe(500);
      expect(await guardRows(externalId)).toHaveLength(0);
      expect(await auditRows(externalId)).toHaveLength(0);

      const retried = await deliver(player.deposit({ externalId, amount: '15' }));

      expect(retried.status).toBe(200);
      expect(await ledgerRows(externalId)).toHaveLength(1);
      expect(await balanceOf(player.userId, player.currency)).toBe(15);
    },
  );

  it('records no refusal for a negative amount under a floor of zero', async () => {
    const player = await setup({ assets: [{ network: NETWORK, minDeposit: '0' }] });
    const event = player.deposit({ amount: '-1' });

    const res = await deliver(event);

    expect(res.status).toBe(500);
    expect(await guardRows(event.externalId)).toHaveLength(0);
    expect(await auditRows(event.externalId)).toHaveLength(0);
  });

  it('still refuses a valid zero under a positive floor', async () => {
    const player = await setup();
    const event = player.deposit({ amount: '0' });

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });

  it.each([
    { label: 'abc', amount: 'abc' },
    { label: '1e3', amount: '1e3' },
    { label: '0x1', amount: '0x1' },
    { label: 'a 400-digit string', amount: '9'.repeat(400) },
  ])('fails a status event for retry on an amount of $label', async ({ amount }) => {
    const player = await setup();
    const event = player.status('detected', { amount });

    const res = await deliver(event);

    expect(res.status).toBe(500);
    expect(await guardRows(event.externalId)).toHaveLength(0);
    expect(await auditRows(event.externalId)).toHaveLength(0);
  });

  it('fails a status event with an empty id for retry and takes no shared slot', async () => {
    const player = await setup();

    const res = await deliver(player.status('detected', { externalId: '' }));

    expect(res.status).toBe(500);
    expect(await guardRows('')).toHaveLength(0);
    expect(await auditRows('')).toHaveLength(0);
  });

  it('fails a below-minimum deposit with an empty id for retry and takes no shared slot', async () => {
    const player = await setup();

    const res = await deliver(player.deposit({ externalId: '', amount: BELOW_FLOOR }));

    expect(res.status).toBe(500);
    expect(await guardRows('')).toHaveLength(0);
    expect(await auditRows('')).toHaveLength(0);
  });

  it('skips a malformed polled status event and still finishes the run', async () => {
    const player = await setup();
    const malformed = player.status('detected', { amount: 'abc' });
    const wellFormed = player.status('detected');

    await reconcile([malformed, wellFormed]);

    expect(await auditRows(malformed.externalId)).toHaveLength(0);
    expect(await auditTrail(wellFormed.externalId)).toEqual(['detected']);
  });
});

describe('the audit chain after all of the above', () => {
  it('still verifies end to end', async () => {
    const audit = new AuditService(
      app().container.get(DRIZZLE),
      app().container.get(EVENT_BUS),
      app().container.get(IDENTITY_READER),
    );

    expect(await audit.verifyChain()).toEqual({ valid: true });
  });
});

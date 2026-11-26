import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { PlayerKycSummaryViewSchema } from '@openora/core/compliance/contract';
import { errorCodeOf } from './support/compliance.js';
import {
  balanceOf,
  newFundedPlayer,
  postWithdrawal,
  saveMaturedWithdrawalAddress,
  waitForAudit,
  type WalletE2e,
} from './support/wallet.js';
import {
  bootKycE2e,
  closeKycE2e,
  countryRuleOf,
  depositExtraCurrency,
  newKycPlayer,
  playerKycStatus,
  settleDecisionQueue,
  postKycWebhook,
  putCountryKyc,
  putGlobalKyc,
  readGlobalKyc,
  registerFromCountry,
  staffClient,
  submitKycOrThrow,
  verificationRows,
  waitForPlayerStatus,
  walletTransactionCount,
  withCountryKyc,
  withGlobalKyc,
} from './support/kyc.js';
import { ipForCountry } from './support/test-kyc-plugin.js';
import { flushAudit, verifyKyc } from '../index.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootKycE2e();
}, 60_000);

afterAll(() => closeKycE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

describe('KYC global switch and withdrawal gate', () => {
  it('admin turns the global KYC switch off and a player with deposits over the threshold withdraws without KYC', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '149' },
      async () => {
        expect((await postWithdrawal(player.client, player)).status).toBe(409);

        await withGlobalKyc(e2e.admin, { enabled: false }, async () => {
          const res = await postWithdrawal(player.client, player);

          expect(res.status).toBe(200);
        });
      },
    );
    expect(await playerKycStatus(e2e, player.userId)).toBe('pending');
    await flushAudit(e2e.app);
    const audit = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'compliance.global_kyc.set'));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('admin turns the global KYC switch on and a player with deposits over the threshold is blocked from withdrawing until approved', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '149' },
      async () => {
        const blocked = await postWithdrawal(player.client, player);
        expect(blocked.status).toBe(409);

        await verifyKyc(e2e.admin, player.userId);
        const unblocked = await postWithdrawal(player.client, player);

        expect(unblocked.status).toBe(200);
      },
    );
  });

  it('player whose cumulative completed deposits stay at the threshold withdraws without KYC', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '150' },
      async () => {
        const res = await postWithdrawal(player.client, player);

        expect(res.status).toBe(200);
      },
    );
    expect(await playerKycStatus(e2e, player.userId)).toBe('pending');
  });

  it('player whose cumulative deposits exceed the threshold in the pivot currency is refused a withdrawal with a KYC-required error', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '149' },
      async () => {
        const res = await postWithdrawal(player.client, player);

        expect(res.status).toBe(409);
        expect(res.body).toEqual(
          expect.objectContaining({
            status: 409,
            message: expect.stringContaining('KYC'),
          }),
        );
        expect(errorCodeOf(res.body)).toEqual(expect.any(String));
      },
    );
  });

  it('deposits in several currencies are summed in the pivot currency before the threshold check', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await depositExtraCurrency(e2e, player, { amount: '100', rated: true });
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '200' },
      async () => {
        const summed = await postWithdrawal(player.client, player);
        expect(summed.status).toBe(409);
      },
    );
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '300' },
      async () => {
        const atSum = await postWithdrawal(player.client, player);
        expect(atSum.status).toBe(200);
      },
    );
  });

  it('a deposit currency that cannot be priced into the pivot currency makes the withdrawal require KYC', async () => {
    const priced = await newFundedPlayer(e2e, '100');
    const unpriced = await newFundedPlayer(e2e, '100');
    const currency = await depositExtraCurrency(e2e, unpriced, { amount: '1', rated: true });
    await db().delete(exchangeRateQuote).where(eq(exchangeRateQuote.baseCurrency, currency));
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '10000' },
      async () => {
        const control = await postWithdrawal(priced.client, priced);
        const refused = await postWithdrawal(unpriced.client, unpriced);

        expect(control.status).toBe(200);
        expect(refused.status).toBe(409);
      },
    );
  });

  it('a withdrawal above the single-withdrawal threshold requires KYC even with deposits under the cumulative threshold', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '10000', withdrawalThreshold: null },
      async () => {
        expect((await postWithdrawal(player.client, player)).status).toBe(200);
      },
    );
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '10000', withdrawalThreshold: '1' },
      async () => {
        const res = await postWithdrawal(player.client, player);

        expect(res.status).toBe(409);
      },
    );
  });

  it('player approved on basic KYC withdraws again and the block is lifted without admin action', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const { referenceId } = await submitKycOrThrow(player.client);
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '149' },
      async () => {
        expect((await postWithdrawal(player.client, player)).status).toBe(409);

        const res = await postKycWebhook(e2e, { referenceId, status: 'approved' });
        expect(res.status).toBe(200);
        await waitForPlayerStatus(e2e, player.userId, 'approved');
        const after = await postWithdrawal(player.client, player);

        expect(after.status).toBe(200);
      },
    );
  });

  it('player with a declined KYC decision stays blocked from withdrawing', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const { referenceId } = await submitKycOrThrow(player.client, { decision: 'rejected' });
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '149' },
      async () => {
        const res = await postKycWebhook(e2e, { referenceId, status: 'rejected' });
        expect(res.status).toBe(200);
        await waitForPlayerStatus(e2e, player.userId, 'rejected');

        const after = await postWithdrawal(player.client, player);

        expect(after.status).toBe(409);
      },
    );
    expect((await verificationRows(e2e, player.userId))[0]?.status).toBe('rejected');
  });

  it('a blocked withdrawal creates no ledger row and leaves the balance unchanged', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const rowsBefore = await walletTransactionCount(e2e, player.userId);
    const balanceBefore = await balanceOf(e2e, player.userId, player.currency);
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '149' },
      async () => {
        const res = await postWithdrawal(player.client, player);

        expect(res.status).toBe(409);
      },
    );
    expect(await walletTransactionCount(e2e, player.userId)).toBe(rowsBefore);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(balanceBefore);
    expect(balanceBefore).toBe('100.000000000000000000');
  });

  it('player cannot read or change the global KYC configuration through the admin route', async () => {
    const player = await newKycPlayer(e2e);
    const before = await readGlobalKyc(e2e.admin);

    const read = await player.client.get('/compliance/global-kyc');
    const write = await player.client.put('/compliance/global-kyc', {
      enabled: !before.enabled,
      confirm: true,
      expectedUpdatedAt: before.updatedAt,
    });

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(await readGlobalKyc(e2e.admin)).toEqual(before);
  });

  it('admin updates the global KYC configuration with a stale version and gets a version conflict', async () => {
    const stale = await readGlobalKyc(e2e.admin);

    await withGlobalKyc(e2e.admin, { cumulativeDepositThreshold: '1234' }, async () => {
      const current = await readGlobalKyc(e2e.admin);
      expect(current.updatedAt).not.toBe(stale.updatedAt);

      const res = await putGlobalKyc(
        e2e.admin,
        { enabled: !stale.enabled, cumulativeDepositThreshold: '4321' },
        stale.updatedAt,
      );

      expect(res.status).toBe(409);
      expect(await readGlobalKyc(e2e.admin)).toEqual(current);
    });
  });
});

describe('Country KYC exemption', () => {
  it('player registering from a country with no KYC requirement is approved at registration', async () => {
    await withGlobalKyc(e2e.admin, { enabled: true }, async () => {
      await withCountryKyc(e2e.admin, 'FI', false, async () => {
        const player = await registerFromCountry(e2e, ipForCountry('FI'));

        await waitForPlayerStatus(e2e, player.userId, 'approved');
        const audit = await waitForAudit(e2e, 'compliance.kyc.updated', player.playerId);
        const sources = audit.map(
          (row) => z.object({ source: z.string() }).parse(row.after).source,
        );
        expect(sources).toContain('exemption');
      });
    });
  });

  it('exempt player withdraws over the cumulative threshold without submitting documents', async () => {
    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '10' },
      async () => {
        await withCountryKyc(e2e.admin, 'SE', false, async () => {
          const player = await registerFromCountry(e2e, ipForCountry('SE'));
          await waitForPlayerStatus(e2e, player.userId, 'approved');
          const currency = await depositExtraCurrency(e2e, player, { amount: '100', rated: true });
          const destinationAddress = await saveMaturedWithdrawalAddress(e2e, player, currency);

          const res = await postWithdrawal(player.client, { currency, destinationAddress });

          expect(res.status).toBe(200);
          const rows = await verificationRows(e2e, player.userId);
          expect(rows.map((row) => row.provider)).toEqual(['exemption']);
        });
      },
    );
  });

  it('player registering from a country that requires KYC starts as not started', async () => {
    await withGlobalKyc(e2e.admin, { enabled: true }, async () => {
      const rule = await putCountryKyc(e2e.admin, 'NO', true);
      expect(rule.status).toBe(200);

      const player = await registerFromCountry(e2e, ipForCountry('NO'));
      await settleDecisionQueue(e2e);

      expect(await playerKycStatus(e2e, player.userId)).toBe('pending');
      expect(await verificationRows(e2e, player.userId)).toHaveLength(0);
      const view = PlayerKycSummaryViewSchema.parse(
        await (await player.client.get('/compliance/kyc/me')).json(),
      );
      expect(view.basic.current).toBeNull();
    });
  });

  it.todo(
    'GAP: exempting a country does not touch existing players, the exemption is applied only to a newly registered player (packages/core/src/compliance/plugin.ts:379 identity.user.registered handler, applyExemption at kyc.service.ts:1175 has no other caller)',
  );

  it('admin without the compliance permission cannot change a country rule', async () => {
    const outsider = await staffClient(e2e, 'kyc-aml-officer');
    const before = await countryRuleOf(e2e.admin, 'DK');

    const res = await outsider.put('/compliance/country-rules', {
      countryCode: 'DK',
      blacklisted: false,
      redirectIp: false,
      kycRequired: false,
      expectedUpdatedAt: before?.updatedAt ?? null,
      confirm: true,
    });

    expect(res.status).toBe(403);
    expect(await countryRuleOf(e2e.admin, 'DK')).toEqual(before);
  });
});

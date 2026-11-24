import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { moneyAdd, moneySubtract } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { adminRole, adminRoleAssignment, adminRolePermission } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import { promoGrant, promoGrantRound } from '@openora/core/promo/schema/bonus';
import { wallet, walletTransaction, walletTurnoverEntry } from '@openora/core/wallet/schema';
import { flushAudit, readJson, registerAndMaterializePlayer } from '../index.js';
import { expectMoney, useBonusLockHarness } from './fixtures/bonus-lock-harness.js';
import { TEST_TURNOVER_LOCKED_MESSAGE } from './fixtures/turnover-gate-config.js';

const CONVERT = '/backoffice/promo/grants/convert-transfer-grants';

const { app, admin, drizzle, player, grant, grantRow, realBalance, withdraw, bet, lose } =
  useBonusLockHarness('block', {
    config: {
      id: 'testing-promo-grant-conversion-config',
      file: './test-promo-grant-conversion-config-plugin.ts',
    },
  });

const convert = async (body: Record<string, unknown>) => {
  const res = await admin().post(CONVERT, body);
  expect(res.status).toBe(200);
  return readJson(res);
};

const conversionCredits = (userId: string) =>
  drizzle()
    .select({ amount: walletTransaction.amount, providerRefId: walletTransaction.providerRefId })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(
      and(
        eq(wallet.userId, userId),
        eq(walletTransaction.type, 'bonus'),
        eq(walletTransaction.providerName, 'promo:grant-conversion'),
      ),
    );

const conversionEntries = (userId: string) =>
  drizzle()
    .select()
    .from(walletTurnoverEntry)
    .where(
      and(
        eq(walletTurnoverEntry.userId, userId),
        eq(walletTurnoverEntry.source, 'grant_conversion'),
      ),
    );

const openRounds = (grantId: string) =>
  drizzle()
    .select({ id: promoGrantRound.id })
    .from(promoGrantRound)
    .where(and(eq(promoGrantRound.grantId, grantId), isNull(promoGrantRound.settledAt)));

const convertedIds = (result: { converted: { grantId: string }[] }) =>
  result.converted.map((row) => row.grantId);

describe('converting a live gift grant', () => {
  it('credits its bonus balance as cash that owes the wagering it had left', async () => {
    const { client, userId } = await player('20');
    const grantId = await grant(userId, {
      source: 'gift',
      amount: '10',
      linked: '5',
      multiplier: '3',
    });
    const before = await realBalance(userId);

    const result = await convert({ sources: ['gift'] });

    expect(result.skippedOpenRound).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.converted).toHaveLength(1);
    const [row] = result.converted;
    expect(row).toMatchObject({ grantId, userId, currency: 'USD', entryStatus: 'counted' });
    expectMoney(row.cash, '10', 'cash');
    expectMoney(row.requiredInCurrency, '30', 'requiredInCurrency');

    expectMoney(await realBalance(userId), moneyAdd(before, '10'), 'real balance');
    const credits = await conversionCredits(userId);
    expect(credits).toHaveLength(1);
    expect(credits[0]?.providerRefId).toBe(grantId);
    expectMoney(credits[0]?.amount ?? '0', '10', 'ledger credit');

    const closed = await grantRow(grantId);
    expect(closed.status).toBe('completed');
    expectMoney(closed.bonusBalance, '0', 'bonus balance');
    expectMoney(closed.linkedCash, '0', 'linked cash');
    expectMoney(closed.unlinkedCash, '0', 'unlinked cash');

    const entries = await conversionEntries(userId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sourceRef: grantId, status: 'counted' });
    expectMoney(entries[0]?.required ?? '0', '30', 'pivot requirement');

    const refused = await withdraw(client, '1');
    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toMatchObject({
      message: TEST_TURNOVER_LOCKED_MESSAGE,
      data: { reason: 'turnover_requirement_unmet', outflow: 'withdrawal' },
    });
    expect((await grantRow(grantId)).status).toBe('completed');

    await flushAudit(app());
    const audits = await drizzle()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'promo.bonus.converted_to_cash'), eq(auditLog.resourceId, grantId)),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'admin', resourceType: 'promo_grant' });
  });

  it('converts nothing on a rerun, and a dry run writes nothing', async () => {
    const { userId } = await player('5');
    const grantId = await grant(userId, {
      source: 'gift',
      amount: '10',
      linked: '0',
      multiplier: '2',
    });

    const preview = await convert({ sources: ['gift'], dryRun: true });
    expect(convertedIds(preview)).toEqual([grantId]);
    expect(preview.converted[0]).toMatchObject({ entryStatus: null });
    expectMoney(preview.converted[0].cash, '10', 'previewed cash');
    expectMoney(preview.converted[0].requiredInCurrency, '20', 'previewed requirement');
    expect(preview.remaining).toBe(1);
    expect((await grantRow(grantId)).status).toBe('active');
    expectMoney(await realBalance(userId), '5', 'real balance after dry run');
    expect(await conversionCredits(userId)).toEqual([]);
    expect(await conversionEntries(userId)).toEqual([]);

    const first = await convert({ sources: ['gift'] });
    expect(convertedIds(first)).toEqual([grantId]);

    const rerun = await convert({ sources: ['gift'] });
    expect(rerun).toEqual({ converted: [], skippedOpenRound: 0, remaining: 0 });
    expectMoney(await realBalance(userId), '15', 'real balance after rerun');
    expect(await conversionCredits(userId)).toHaveLength(1);
    expect(await conversionEntries(userId)).toHaveLength(1);
  });

  it('skips a grant with an open round and converts it once the round settles', async () => {
    const { userId } = await player('1');
    const grantId = await grant(userId, {
      source: 'gift',
      amount: '10',
      linked: '0',
      multiplier: '3',
      order: 'last',
    });
    const round = randomUUID();
    expect(await bet(userId, '2', round)).toMatchObject({ ok: true });
    expect(await openRounds(grantId)).toHaveLength(1);

    const skipped = await convert({ sources: ['gift'] });
    expect(skipped).toEqual({ converted: [], skippedOpenRound: 1, remaining: 1 });
    expect((await grantRow(grantId)).status).toBe('active');

    expect(await lose(userId, round)).toMatchObject({ ok: true });
    const settled = await grantRow(grantId);
    const owed = moneySubtract(settled.wageringRequired, settled.wageringProgress);

    const converted = await convert({ sources: ['gift'] });
    expect(converted.skippedOpenRound).toBe(0);
    expect(converted.remaining).toBe(0);
    expect(convertedIds(converted)).toEqual([grantId]);
    expectMoney(converted.converted[0].cash, settled.bonusBalance, 'cash');
    expectMoney(converted.converted[0].requiredInCurrency, owed, 'requirement');
  });

  it('leaves deposit-bonus grants and unrequested sources alone', async () => {
    const depositHolder = await player('20');
    const depositGrant = await grant(depositHolder.userId, {
      source: 'deposit',
      amount: '10',
      linked: '10',
    });
    const rainHolder = await player('1');
    const rainGrant = await grant(rainHolder.userId, { source: 'rain', amount: '10', linked: '0' });

    const result = await convert({ sources: ['gift', 'donation'] });

    expect(convertedIds(result)).not.toContain(depositGrant);
    expect(convertedIds(result)).not.toContain(rainGrant);
    expect((await grantRow(depositGrant)).status).toBe('active');
    expect((await grantRow(rainGrant)).status).toBe('active');
    expect(await conversionCredits(rainHolder.userId)).toEqual([]);

    const rain = await convert({ sources: ['rain'] });
    expect(convertedIds(rain)).toEqual([rainGrant]);
    expect((await grantRow(depositGrant)).status).toBe('active');
  });

  it('does not convert an expired grant', async () => {
    const { userId } = await player('1');
    const grantId = await grant(userId, { source: 'donation', amount: '10', linked: '0' });
    await drizzle()
      .update(promoGrant)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(promoGrant.id, grantId));

    const result = await convert({ sources: ['donation'] });

    expect(result).toEqual({ converted: [], skippedOpenRound: 0, remaining: 0 });
    expect((await grantRow(grantId)).status).toBe('active');
    expect(await conversionCredits(userId)).toEqual([]);
  });
});

describe('who may convert', () => {
  async function staffWithBonusWrite() {
    const staff = await registerAndMaterializePlayer(app(), {
      email: `conversion-staff-${randomUUID()}@e2e.test`,
    });
    await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, staff.userId));
    const [role] = await drizzle()
      .insert(adminRole)
      .values({ name: `conversion staff ${randomUUID()}` })
      .returning({ id: adminRole.id });
    if (!role) {
      throw new Error('role insert returned no row');
    }
    await drizzle()
      .insert(adminRolePermission)
      .values({ roleId: role.id, resource: 'bonus', level: 'read_write' });
    await drizzle().insert(adminRoleAssignment).values({ userId: staff.userId, roleId: role.id });
    return staff.client;
  }

  it('refuses staff who are not super-admins, players, and anonymous callers', async () => {
    const { userId } = await player('1');
    const grantId = await grant(userId, { source: 'gift', amount: '10', linked: '0' });

    const staff = await staffWithBonusWrite();
    expect((await staff.post(CONVERT, { sources: ['gift'] })).status).toBe(403);

    const { client } = await player('1');
    expect((await client.post(CONVERT, { sources: ['gift'] })).status).toBe(403);

    const anonymous = await app().app.request(CONVERT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: ['gift'] }),
    });
    expect(anonymous.status).toBe(401);

    expect((await grantRow(grantId)).status).toBe('active');
    await convert({ sources: ['gift'] });
  });
});

describe('a conversion racing a bet on the same grant', () => {
  it('either converts the grant or leaves the bet its round, never both', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { userId } = await player('5');
      const grantId = await grant(userId, {
        source: 'gift',
        amount: '10',
        linked: '0',
        multiplier: '3',
        order: 'last',
      });
      const round = randomUUID();

      const [conversion, staked] = await Promise.all([
        admin().post(CONVERT, { sources: ['gift'] }),
        bet(userId, '10', round),
      ]);

      expect(conversion.status).toBe(200);
      expect(staked).toMatchObject({ ok: true });
      const result = await readJson(conversion);
      const row = await grantRow(grantId);
      if (convertedIds(result).includes(grantId)) {
        expect(row.status).toBe('completed');
        expect(await openRounds(grantId)).toEqual([]);
        expectMoney(await realBalance(userId), '5', 'real balance after conversion then bet');
      } else {
        expect(result.skippedOpenRound).toBe(1);
        expect(row.status).toBe('active');
        expectMoney(row.bonusBalance, '0', 'bonus balance after the bet');
        expectMoney(await realBalance(userId), '5', 'real balance after bet then skip');
        expect(await conversionCredits(userId)).toEqual([]);
        await lose(userId, round);
        await convert({ sources: ['gift'] });
      }
    }
  });
});

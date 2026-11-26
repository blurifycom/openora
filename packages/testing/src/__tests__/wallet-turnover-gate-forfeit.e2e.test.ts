import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { eventOutbox } from '@openora/core/server';
import { readJson } from '../index.js';
import { expectMoney, useBonusLockHarness } from './support/bonus-lock-harness.js';
import { TEST_TURNOVER_LOCKED_MESSAGE } from './support/turnover-gate-config.js';

const { admin, drizzle, player, grant, grantRow, realBalance, ledgerRows, withdraw } =
  useBonusLockHarness('forfeit', {
    config: {
      id: 'testing-wallet-turnover-forfeit-config',
      file: './test-wallet-turnover-forfeit-config-plugin.ts',
    },
  });

const forfeitedEvents = (userId: string) =>
  drizzle()
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.topic, 'promo.bonus.forfeited'),
        sql`${eventOutbox.payload}->>'userId' = ${userId}`,
      ),
    );

describe('a withdrawal refused on turnover in forfeit mode', () => {
  it('keeps every grant live and announces no forfeit, then forfeits once the requirement is cleared', async () => {
    const { client, userId } = await player('150');
    const grants = [await grant(userId), await grant(userId, { source: 'rank', currency: 'EUR' })];

    const res = await withdraw(client, '10');

    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({
      message: TEST_TURNOVER_LOCKED_MESSAGE,
      data: { reason: 'turnover_requirement_unmet', outflow: 'withdrawal', pending: false },
    });
    for (const id of grants) {
      expect((await grantRow(id)).status).toBe('active');
    }
    expect(await forfeitedEvents(userId)).toHaveLength(0);
    expectMoney(await realBalance(userId), '150', 'balance');
    expect(await ledgerRows(userId, 'withdrawal')).toHaveLength(0);

    const cleared = await admin().post(`/wallet/admin/players/${userId}/turnover/clear`, {
      userId,
      reason: 'verified source of funds',
    });
    expect(cleared.status).toBe(200);
    expect((await withdraw(client, '10')).status).toBe(200);
    for (const id of grants) {
      expect((await grantRow(id)).status).toBe('forfeited');
    }
    expect(await forfeitedEvents(userId)).toHaveLength(2);
  });
});

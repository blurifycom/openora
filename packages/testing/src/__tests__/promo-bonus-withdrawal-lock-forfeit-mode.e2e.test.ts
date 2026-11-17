import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LOCKED_FUNDS_MESSAGE } from '@openora/core/contracts';
import { readJson } from '../index.js';
import { expectMoney, useBonusLockHarness } from './fixtures/bonus-lock-harness.js';

const { drizzle, commands, player, grant, grantRow, realBalance, withdraw, btcHolder, swap } =
  useBonusLockHarness('forfeit');

describe('the default withdrawal mode forfeits, and swaps and gifts are still protected', () => {
  it('forfeits every live bonus of every source and currency on a withdrawal under the free money', async () => {
    const { client, userId } = await player('150');
    const grants = [
      await grant(userId),
      await grant(userId, { source: 'rank', currency: 'EUR' }),
      await grant(userId, { source: 'manual', lock: true, currency: 'GBP' }),
    ];

    const res = await withdraw(client, '10');

    expect(res.status).toBe(200);
    for (const id of grants) {
      expect(await grantRow(id)).toMatchObject({
        status: 'forfeited',
        forfeitReason: 'withdrawal_while_active',
      });
    }
  });

  it('pays a withdrawal over the free money and forfeits, as before the lock existed', async () => {
    const { client, userId } = await player('150');
    const id = await grant(userId);

    const res = await withdraw(client, '150');

    expect(res.status).toBe(200);
    expectMoney(await realBalance(userId), '0', 'balance');
    expect((await grantRow(id)).status).toBe('forfeited');
  });

  it('refuses a gift over the free money with the generic message and keeps the bonus', async () => {
    const sender = await player('150');
    const recipient = await player('10');
    const id = await grant(sender.userId);
    const gift = (userId: string) => ({
      userId,
      amount: '60',
      type: 'gift' as const,
      currency: 'USD',
      providerRef: { providerName: 'gifts', providerRefId: randomUUID() },
    });

    await expect(
      drizzle().transaction(async (tx) => {
        await commands().credit(tx, gift(recipient.userId));
        await commands().debit(tx, gift(sender.userId));
      }),
    ).rejects.toMatchObject({
      name: 'BonusFundsLockedError',
      message: DEFAULT_LOCKED_FUNDS_MESSAGE,
    });
    expect((await grantRow(id)).status).toBe('active');
    expectMoney(await realBalance(sender.userId), '150', 'sender balance');
  });

  it('refuses a swap over the free money without forfeiting', async () => {
    const { client, grantId } = await btcHolder();

    const res = await swap(client, '0.01');

    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({
      message: DEFAULT_LOCKED_FUNDS_MESSAGE,
      data: { reason: 'bonus_funds_locked', outflow: 'swap' },
    });
    expect((await grantRow(grantId)).status).toBe('active');
  });

  it('settles a swap of the free money without forfeiting', async () => {
    const { client, grantId } = await btcHolder();

    expect((await swap(client, '0.005')).status).toBe(200);
    expect((await grantRow(grantId)).status).toBe('active');
  });
});

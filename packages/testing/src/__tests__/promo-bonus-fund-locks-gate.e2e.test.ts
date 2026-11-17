import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '@openora/core/server';
import {
  WALLET_LOCK_EXEMPT_DEBIT_TYPES,
  WALLET_TRANSACTION_TYPES,
  type WalletTransactionType,
} from '@openora/core/contracts';
import { bootE2e, closeE2e } from '../index.js';
import { expectMoney, useBonusLockHarness } from './fixtures/bonus-lock-harness.js';

const fixture = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const blockConfig = {
  id: 'testing-bonus-withdrawal-block-config',
  path: fixture('./fixtures/test-bonus-withdrawal-block-config-plugin.ts'),
};

const { drizzle, commands, player, grant, realBalance } = useBonusLockHarness('block');

const outflowOf = (type: WalletTransactionType) =>
  type === 'withdrawal' ? 'withdrawal' : type === 'swap_out' ? 'swap' : 'transfer';

const exempt: readonly string[] = WALLET_LOCK_EXEMPT_DEBIT_TYPES;
// win_reversal only goes through correctionDebit, which debit refuses outright.
const checked = WALLET_TRANSACTION_TYPES.filter(
  (type) => type !== 'win_reversal' && !exempt.includes(type),
);

describe('every debit type is either exempt or checked against the bonus lock', () => {
  it.each(checked)('refuses a %s debit over the free money and moves nothing', async (type) => {
    const { userId } = await player('150');
    await grant(userId);

    await expect(
      drizzle().transaction((tx) =>
        commands().debit(tx, {
          userId,
          amount: '60',
          type,
          currency: 'USD',
          providerRef: { providerName: 'consumer', providerRefId: randomUUID() },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'BonusFundsLockedError',
      data: { reason: 'bonus_funds_locked', outflow: outflowOf(type) },
    });
    expectMoney(await realBalance(userId), '150', 'balance');
  });

  it.each(checked)('lets a %s debit up to the free money through', async (type) => {
    const { userId } = await player('150');
    await grant(userId);

    await drizzle().transaction(async (tx) => {
      expect(
        await commands().debit(tx, {
          userId,
          amount: '50',
          type,
          currency: 'USD',
          providerRef: { providerName: 'consumer', providerRefId: randomUUID() },
        }),
      ).toMatchObject({ ok: true });
    });
    expectMoney(await realBalance(userId), '100', 'balance');
  });

  it.each(['bet', 'manual_debit'] as const)('never refuses a %s debit', async (type) => {
    const { userId } = await player('150');
    await grant(userId);

    await drizzle().transaction(async (tx) => {
      expect(
        await commands().debit(tx, { userId, amount: '60', type, currency: 'USD' }),
      ).toMatchObject({ ok: true });
    });
  });

  it('never refuses a loss row, which moves no money', async () => {
    const { userId } = await player('150');
    await grant(userId);

    await drizzle().transaction(async (tx) => {
      expect(
        await commands().debit(tx, { userId, amount: '0', type: 'loss', currency: 'USD' }),
      ).toMatchObject({ ok: true });
    });
    expectMoney(await realBalance(userId), '150', 'balance');
  });
});

describe('booting with the bonus withdrawal mode', () => {
  it('boots in the default forfeit mode with no bonus module', async () => {
    const plugins = (await loadExtensions()).filter((entry) => entry.id !== 'bonus');

    const booted = await bootE2e({ plugins });
    await closeE2e(booted);
  });

  it.each([
    [
      'provide',
      'testing-bonus-lock-rebind-provide',
      './fixtures/test-bonus-lock-rebind-provide-plugin.ts',
    ],
    [
      'provideSealed',
      'testing-bonus-lock-rebind-sealed',
      './fixtures/test-bonus-lock-rebind-sealed-plugin.ts',
    ],
  ] as const)('refuses an overlay rebinding the locks with %s', async (_, id, file) => {
    const plugins = await loadExtensions();

    await expect(
      bootE2e({ plugins: [...plugins, blockConfig, { id, path: fixture(file) }] }),
    ).rejects.toThrow(/sealed|already bound/i);
  });
});

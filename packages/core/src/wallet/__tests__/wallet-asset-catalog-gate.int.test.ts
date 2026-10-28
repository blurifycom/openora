import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PaymentAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  NO_CLIENT_META,
  makeAuditWriter,
  makeExchangeRateReader,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletAsset, walletBalance, walletTransaction } from '../schema/index.js';
import {
  WalletService,
  assertAboveMinimumDeposit,
  assertDepositAllowed,
  resolveWithdrawalNetwork,
  BelowMinimumDepositError,
  DepositDisabledError,
  UnsupportedNetworkError,
  WithdrawalDisabledError,
  AmbiguousNetworkError,
} from '../service/wallet.service.js';

let db: TestDb;

function makeService() {
  const processDeposit = vi.fn(async () => ({
    externalId: randomUUID(),
    status: 'completed' as const,
  }));
  const svc = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({ processDeposit }),
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
    rates: makeExchangeRateReader(),
  });
  return { svc, processDeposit };
}

async function seedWallet(balance = '100', currency = 'USDT') {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID(), currency }).returning(),
    new Error('seedWallet: no row'),
  );
  await db.drizzle.db.insert(walletBalance).values({ walletId: row.id, currency, amount: balance });
  return row;
}

const seedAsset = (network: string, overrides: Partial<typeof walletAsset.$inferInsert> = {}) =>
  db.drizzle.db.insert(walletAsset).values({
    currency: 'USDT',
    network,
    providerAssetId: `USDT_${network}`,
    minDeposit: '0',
    minWithdrawal: '0',
    withdrawalFee: '0',
    ...overrides,
  });

const ledgerRows = () => db.drizzle.db.select().from(walletTransaction);

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletAsset}, ${walletBalance}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletService.deposit catalog gate (real PG)', () => {
  it('refuses a deposit when every network of the currency is disabled, charging nothing', async () => {
    const { svc, processDeposit } = makeService();
    const w = await seedWallet();
    await seedAsset('ERC20', { depositEnabled: false });
    await seedAsset('TRC20', { depositEnabled: false });

    await expect(
      svc.deposit({ userId: w.userId, amount: '10', currency: 'USDT' }),
    ).rejects.toBeInstanceOf(DepositDisabledError);
    expect(processDeposit).not.toHaveBeenCalled();
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('accepts a deposit when at least one network is enabled, whichever row comes first', async () => {
    const { svc } = makeService();
    const w = await seedWallet();
    await seedAsset('ERC20', { depositEnabled: false });
    await seedAsset('TRC20', { depositEnabled: true });

    const result = await svc.deposit({ userId: w.userId, amount: '10', currency: 'USDT' });

    expect(result.status).toBe('completed');
  });

  it('matches the catalog by currency case-insensitively', async () => {
    const { svc } = makeService();
    const w = await seedWallet();
    await seedAsset('ERC20', { depositEnabled: false });

    await expect(
      svc.deposit({ userId: w.userId, amount: '10', currency: 'usdt' }),
    ).rejects.toBeInstanceOf(DepositDisabledError);
  });

  it('accepts a deposit exactly at the minimum and refuses one a hair under it', async () => {
    const { svc, processDeposit } = makeService();
    const w = await seedWallet();
    await seedAsset('ERC20', { minDeposit: '25' });

    await expect(
      svc.deposit({ userId: w.userId, amount: '24.999999999999999999', currency: 'USDT' }),
    ).rejects.toBeInstanceOf(BelowMinimumDepositError);
    expect(processDeposit).not.toHaveBeenCalled();
    expect((await svc.deposit({ userId: w.userId, amount: '25', currency: 'USDT' })).status).toBe(
      'completed',
    );
  });

  it('judges a currency-level deposit against the lowest enabled floor, ignoring a disabled network', async () => {
    const { svc } = makeService();
    const w = await seedWallet();
    await seedAsset('ERC20', { minDeposit: '25' });
    await seedAsset('TRC20', { minDeposit: '5' });
    await seedAsset('BEP20', { minDeposit: '1', depositEnabled: false });

    await expect(
      svc.deposit({ userId: w.userId, amount: '4', currency: 'USDT' }),
    ).rejects.toBeInstanceOf(BelowMinimumDepositError);
    expect((await svc.deposit({ userId: w.userId, amount: '5', currency: 'USDT' })).status).toBe(
      'completed',
    );
  });

  it('leaves a fiat currency with no catalog rows ungated', async () => {
    const { svc } = makeService();
    const w = await seedWallet('0', 'USD');

    expect((await svc.deposit({ userId: w.userId, amount: '1', currency: 'USD' })).status).toBe(
      'completed',
    );
    expect(
      await db.drizzle.db.select().from(walletBalance).where(eq(walletBalance.walletId, w.id)),
    ).toHaveLength(1);
  });
});

describe('assertDepositAllowed (catalog rows)', () => {
  const row = (network: string, depositEnabled: boolean) => ({
    network,
    minDeposit: '0',
    depositEnabled,
  });

  it('refuses a named network that is disabled and reports that network', () => {
    expect(() => assertDepositAllowed([row('ERC20', false)], 'USDT', 'erc20')).toThrow(
      DepositDisabledError,
    );
    expect(() => assertDepositAllowed([row('ERC20', false)], 'USDT', 'erc20')).toThrow(/ERC20/);
  });

  it('allows a named enabled network, matched case-insensitively', () => {
    expect(() =>
      assertDepositAllowed([row('ERC20', false), row('TRC20', true)], 'USDT', 'trc20'),
    ).not.toThrow();
  });

  it('refuses a network the catalog does not list, or any named network on an empty catalog', () => {
    expect(() => assertDepositAllowed([row('ERC20', true)], 'USDT', 'TRC20')).toThrow(
      UnsupportedNetworkError,
    );
    expect(() => assertDepositAllowed([], 'USDT', 'trc20')).toThrow(/TRC20/);
    expect(() => assertDepositAllowed([], 'USD')).not.toThrow();
  });

  it('refuses a currency-level request when every row is disabled, and allows it when one is enabled', () => {
    expect(() => assertDepositAllowed([row('ERC20', false)], 'USDT')).toThrow(DepositDisabledError);
    expect(() =>
      assertDepositAllowed([row('ERC20', false), row('TRC20', true)], 'USDT'),
    ).not.toThrow();
    expect(() =>
      assertDepositAllowed([row('ERC20', true), row('TRC20', false)], 'USDT'),
    ).not.toThrow();
  });
});

describe('assertAboveMinimumDeposit (catalog rows)', () => {
  const row = (network: string, minDeposit: string, depositEnabled = true) => ({
    network,
    minDeposit,
    depositEnabled,
  });

  it('lets an amount equal to the floor through and stops one under it', () => {
    const assets = [row('ERC20', '10')];
    expect(() => assertAboveMinimumDeposit(assets, '10', 'USDT')).not.toThrow();
    expect(() => assertAboveMinimumDeposit(assets, '9.99', 'USDT')).toThrow(
      BelowMinimumDepositError,
    );
  });

  it('keeps the first network on a floor tie and takes a lower floor wherever it sits', () => {
    const tie = [row('ERC20', '10'), row('TRC20', '10')];
    expect(() => assertAboveMinimumDeposit(tie, '9', 'USDT')).toThrow(/on ERC20/);
    const lowerLast = [row('ERC20', '25'), row('TRC20', '5')];
    expect(() => assertAboveMinimumDeposit(lowerLast, '4', 'USDT')).toThrow(/on TRC20/);
    expect(() => assertAboveMinimumDeposit(lowerLast, '5', 'USDT')).not.toThrow();
    const lowerFirst = [row('TRC20', '5'), row('ERC20', '25')];
    expect(() => assertAboveMinimumDeposit(lowerFirst, '4', 'USDT')).toThrow(/on TRC20/);
  });

  it('applies only the named network floor, case-insensitively, and ignores disabled rows', () => {
    const assets = [row('ERC20', '25'), row('TRC20', '5'), row('BEP20', '1', false)];
    expect(() => assertAboveMinimumDeposit(assets, '10', 'USDT', 'erc20')).toThrow(/on ERC20/);
    expect(() => assertAboveMinimumDeposit(assets, '10', 'USDT', 'trc20')).not.toThrow();
    expect(() => assertAboveMinimumDeposit(assets, '0.5', 'USDT', 'bep20')).not.toThrow();
  });

  it('has no floor to enforce when nothing is enabled', () => {
    expect(() => assertAboveMinimumDeposit([row('ERC20', '25', false)], '1', 'USDT')).not.toThrow();
    expect(() => assertAboveMinimumDeposit([], '1', 'USDT')).not.toThrow();
  });
});

describe('resolveWithdrawalNetwork', () => {
  const row = (network: string, withdrawalEnabled = true) => ({
    network,
    minWithdrawal: '0',
    withdrawalEnabled,
  });

  it('refuses a network that is not payable, naming it in upper case', () => {
    expect(() => resolveWithdrawalNetwork([row('ERC20')], 'USDT', 'trc20')).toThrow(
      UnsupportedNetworkError,
    );
    expect(() => resolveWithdrawalNetwork([row('ERC20')], 'USDT', 'trc20')).toThrow(/TRC20/);
    expect(() =>
      resolveWithdrawalNetwork([row('ERC20'), row('TRC20', false)], 'USDT', 'trc20'),
    ).toThrow(UnsupportedNetworkError);
  });

  it('settles a named payable network, case-insensitively, and an implied single one', () => {
    expect(resolveWithdrawalNetwork([row('ERC20'), row('TRC20')], 'USDT', 'trc20')).toBe('TRC20');
    expect(resolveWithdrawalNetwork([row('ERC20'), row('TRC20', false)], 'USDT')).toBe('ERC20');
    expect(resolveWithdrawalNetwork([], 'USD', 'any')).toBe('ANY');
    expect(resolveWithdrawalNetwork([], 'USD')).toBeNull();
  });

  it('fails closed when every network is disabled, and demands a network when several are payable', () => {
    expect(() => resolveWithdrawalNetwork([row('ERC20', false)], 'USDT')).toThrow(
      WithdrawalDisabledError,
    );
    expect(() => resolveWithdrawalNetwork([row('ERC20'), row('TRC20')], 'USDT')).toThrow(
      AmbiguousNetworkError,
    );
  });
});

describe('WalletService.withdraw network gate (real PG)', () => {
  it('refuses an unlisted network without holding any funds', async () => {
    const { svc } = makeService();
    const w = await seedWallet('100');
    await seedAsset('ERC20');

    await expect(
      svc.withdraw({
        userId: w.userId,
        amount: '10',
        currency: 'USDT',
        network: 'TRC20',
        destinationAddress: '0xexample',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(UnsupportedNetworkError);
    expect(await ledgerRows()).toHaveLength(0);
    const [balance] = await db.drizzle.db.select().from(walletBalance);
    expect(Number(balance?.amount)).toBe(100);
  });
});

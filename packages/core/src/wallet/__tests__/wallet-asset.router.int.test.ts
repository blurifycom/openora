import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { PaymentAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
  makeIdentityReader,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction, walletAsset } from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';

const CTX = testContext();
const CALLER_ID = '9a2f7c11-0000-4000-8000-0000000000cc';

const USDT_ERC20 = {
  currency: 'USDT',
  network: 'ERC20',
  providerAssetId: 'USDT_ERC20',
  minDeposit: '10',
  minWithdrawal: '20',
  withdrawalFee: '5',
} as const;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(walletTransaction);
  await db.drizzle.db.delete(walletBalance);
  await db.drizzle.db.delete(wallet);
  await db.drizzle.db.delete(walletAsset);
});

const adminGuard = () => makeAdminGuard({ caller: { userId: CALLER_ID, role: 'admin' } });

const denyingGuard = () =>
  makeAdminGuard({
    deny: [
      'wallet-asset:view',
      'wallet-asset:create',
      'wallet-asset:update',
      'wallet-asset:delete',
    ],
    caller: { userId: CALLER_ID, role: 'support' },
  });

function routerWith(
  guard: AdminGuard,
  payment?: Partial<PaymentAdapter>,
  providerNames?: readonly string[],
) {
  const audit = makeAuditWriter();
  const paymentProviders = makePaymentProviderRegistry(
    providerNames ? { names: providerNames } : {},
  );
  const service = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>(payment ?? {}),
    paymentProviders,
    audit,
    identityReader: makeIdentityReader(),
  });
  const router = createWalletRouter(service, guard, audit, paymentProviders);
  return { router, audit, service };
}

async function seedBalance(currency: string, amount: string) {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID(), currency }).returning(),
    new Error('seedBalance: query returned no row'),
  );
  await db.drizzle.db.insert(walletBalance).values({ walletId: row.id, currency, amount });
  return row;
}

describe('wallet asset catalog routes', () => {
  it('create: persists a row, normalizes casing, and audits', async () => {
    const { router, audit } = routerWith(adminGuard());

    const created = await call(
      router.assets.create,
      { ...USDT_ERC20, currency: 'usdt', network: 'erc20' },
      { context: CTX },
    );

    expect(created).toMatchObject({
      currency: 'USDT',
      network: 'ERC20',
      providerAssetId: 'USDT_ERC20',
      depositEnabled: true,
      withdrawalEnabled: true,
    });
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'wallet.wallet_asset.created' }),
    );
  });

  it('create: rejects a duplicate (currency, network)', async () => {
    const { router } = routerWith(adminGuard());
    await call(router.assets.create, { ...USDT_ERC20 }, { context: CTX });

    await expect(
      call(router.assets.create, { ...USDT_ERC20, providerAssetId: 'OTHER' }, { context: CTX }),
    ).rejects.toThrow(ORPCError);
  });

  it('create: allows the same currency on a second network', async () => {
    const { router } = routerWith(adminGuard());
    await call(router.assets.create, { ...USDT_ERC20 }, { context: CTX });

    const bep20 = await call(
      router.assets.create,
      { ...USDT_ERC20, network: 'BEP20', providerAssetId: 'USDT_BSC' },
      { context: CTX },
    );

    expect(bep20).toMatchObject({ currency: 'USDT', network: 'BEP20' });
  });

  it('create: rejects a pair the bound adapter cannot serve', async () => {
    const { router } = routerWith(adminGuard(), { supportsAsset: () => false });

    await expect(call(router.assets.create, { ...USDT_ERC20 }, { context: CTX })).rejects.toThrow(
      ORPCError,
    );
  });

  it('create: rejects a providerName not in the bound registry', async () => {
    const { router } = routerWith(adminGuard(), undefined, ['vendor-a']);

    await expect(
      call(router.assets.create, { ...USDT_ERC20, providerName: 'vendor-b' }, { context: CTX }),
    ).rejects.toThrow(ORPCError);
  });

  it('create: accepts a providerName the registry knows', async () => {
    const { router } = routerWith(adminGuard(), undefined, ['vendor-a']);

    const created = await call(
      router.assets.create,
      { ...USDT_ERC20, providerName: 'vendor-a' },
      { context: CTX },
    );

    expect(created).toMatchObject({ providerName: 'vendor-a' });
  });

  it('create: an omitted providerName falls back to the default binding (null column)', async () => {
    const { router } = routerWith(adminGuard());

    const created = await call(router.assets.create, { ...USDT_ERC20 }, { context: CTX });

    expect(created.providerName).toBeNull();
  });

  it('listAssets: is public and hides fully-disabled pairs and the vendor id', async () => {
    const { router } = routerWith(adminGuard());
    await call(router.assets.create, { ...USDT_ERC20 }, { context: CTX });
    await call(
      router.assets.create,
      {
        ...USDT_ERC20,
        network: 'TRC20',
        providerAssetId: 'USDT_TRX',
        depositEnabled: false,
        withdrawalEnabled: false,
      },
      { context: CTX },
    );

    const listed = await call(router.listAssets, {}, { context: CTX });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ currency: 'USDT', network: 'ERC20' });
    expect(listed[0]).not.toHaveProperty('providerAssetId');
  });

  it('listAssets: hides providerName, sweepFeeCeiling and poolLiquidityFloor from the public catalog', async () => {
    const { router } = routerWith(adminGuard(), undefined, ['vendor-a']);
    await call(
      router.assets.create,
      { ...USDT_ERC20, providerName: 'vendor-a', sweepFeeCeiling: '2', poolLiquidityFloor: '100' },
      { context: CTX },
    );

    const [listed] = await call(router.listAssets, {}, { context: CTX });

    expect(listed).not.toHaveProperty('providerName');
    expect(listed).not.toHaveProperty('sweepFeeCeiling');
    expect(listed).not.toHaveProperty('poolLiquidityFloor');
  });

  it('list: exposes providerName, sweepFeeCeiling and poolLiquidityFloor for an admin', async () => {
    const { router } = routerWith(adminGuard(), undefined, ['vendor-a']);
    await call(
      router.assets.create,
      { ...USDT_ERC20, providerName: 'vendor-a', sweepFeeCeiling: '2', poolLiquidityFloor: '100' },
      { context: CTX },
    );

    const [listed] = await call(router.assets.list, {}, { context: CTX });

    expect(listed).toMatchObject({
      providerName: 'vendor-a',
      sweepFeeCeiling: '2.000000000000000000',
      poolLiquidityFloor: '100.000000000000000000',
    });
  });

  it('listAssets: keeps a pair enabled on only one side', async () => {
    const { router } = routerWith(adminGuard());
    await call(router.assets.create, { ...USDT_ERC20, withdrawalEnabled: false }, { context: CTX });

    const listed = await call(router.listAssets, {}, { context: CTX });

    expect(listed).toMatchObject([{ depositEnabled: true, withdrawalEnabled: false }]);
  });

  it('list: returns disabled rows and the vendor id for an admin', async () => {
    const { router } = routerWith(adminGuard());
    await call(
      router.assets.create,
      { ...USDT_ERC20, depositEnabled: false, withdrawalEnabled: false },
      { context: CTX },
    );

    const listed = await call(router.assets.list, {}, { context: CTX });

    expect(listed).toMatchObject([{ providerAssetId: 'USDT_ERC20', depositEnabled: false }]);
  });

  it('update: applies a partial change without restating amounts', async () => {
    const { router, audit } = routerWith(adminGuard());
    await call(router.assets.create, { ...USDT_ERC20 }, { context: CTX });

    const updated = await call(
      router.assets.update,
      { currency: 'USDT', network: 'ERC20', withdrawalEnabled: false },
      { context: CTX },
    );

    expect(updated).toMatchObject({ withdrawalEnabled: false, depositEnabled: true });
    expect(updated.minWithdrawal).toBe('20.000000000000000000');
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'wallet.wallet_asset.updated' }),
    );
  });

  it('update: providerName is not an editable field - it stays whatever create set', async () => {
    const { router } = routerWith(adminGuard(), undefined, ['vendor-a']);
    await call(router.assets.create, { ...USDT_ERC20, providerName: 'vendor-a' }, { context: CTX });

    const updated = await call(
      router.assets.update,
      // No `providerName` key exists on UpdateWalletAssetInputSchema - the type system
      // (not a runtime check) is what makes this immutable.
      { currency: 'USDT', network: 'ERC20', withdrawalEnabled: false },
      { context: CTX },
    );

    expect(updated.providerName).toBe('vendor-a');
  });

  it('update: 404s on a pair that does not exist', async () => {
    const { router } = routerWith(adminGuard());

    await expect(
      call(
        router.assets.update,
        { currency: 'USDT', network: 'ERC20', withdrawalFee: '1' },
        { context: CTX },
      ),
    ).rejects.toThrow(ORPCError);
  });

  it('delete: removes a pair no player holds', async () => {
    const { router, audit } = routerWith(adminGuard());
    await call(router.assets.create, { ...USDT_ERC20 }, { context: CTX });

    const deleted = await call(
      router.assets.delete,
      { currency: 'USDT', network: 'ERC20' },
      { context: CTX },
    );

    expect(deleted).toBe(true);
    expect(await call(router.assets.list, {}, { context: CTX })).toEqual([]);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'wallet.wallet_asset.deleted' }),
    );
  });

  it('delete: is blocked while a player still holds that currency', async () => {
    const { router } = routerWith(adminGuard());
    await call(router.assets.create, { ...USDT_ERC20 }, { context: CTX });
    await seedBalance('USDT', '5');

    await expect(
      call(router.assets.delete, { currency: 'USDT', network: 'ERC20' }, { context: CTX }),
    ).rejects.toThrow(ORPCError);
    expect(await call(router.assets.list, {}, { context: CTX })).toHaveLength(1);
  });

  it('delete: allows removal once the held balance is zero', async () => {
    const { router } = routerWith(adminGuard());
    await call(router.assets.create, { ...USDT_ERC20 }, { context: CTX });
    await seedBalance('USDT', '0');

    await expect(
      call(router.assets.delete, { currency: 'USDT', network: 'ERC20' }, { context: CTX }),
    ).resolves.toBe(true);
  });

  it('delete: is blocked while a pending/processing transaction exists for the pair - renaming providerName is a delete + create', async () => {
    const { router } = routerWith(adminGuard());
    await call(router.assets.create, { ...USDT_ERC20 }, { context: CTX });
    const w = await seedBalance('USDT', '0');
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: w.id,
      type: 'withdrawal',
      amount: '5',
      currency: 'USDT',
      network: 'ERC20',
      status: 'processing',
      rail: 'crypto',
    });

    await expect(
      call(router.assets.delete, { currency: 'USDT', network: 'ERC20' }, { context: CTX }),
    ).rejects.toThrow(ORPCError);
    expect(await call(router.assets.list, {}, { context: CTX })).toHaveLength(1);
  });

  it('delete: allows removal once the in-flight transaction reaches a terminal state', async () => {
    const { router } = routerWith(adminGuard());
    await call(router.assets.create, { ...USDT_ERC20 }, { context: CTX });
    const w = await seedBalance('USDT', '0');
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: w.id,
      type: 'withdrawal',
      amount: '5',
      currency: 'USDT',
      network: 'ERC20',
      status: 'completed',
      rail: 'crypto',
    });

    await expect(
      call(router.assets.delete, { currency: 'USDT', network: 'ERC20' }, { context: CTX }),
    ).resolves.toBe(true);
  });

  it('delete: reports false for a pair that was never configured', async () => {
    const { router } = routerWith(adminGuard());

    await expect(
      call(router.assets.delete, { currency: 'USDT', network: 'ERC20' }, { context: CTX }),
    ).resolves.toBe(false);
  });

  it('admin routes reject a caller without the wallet-asset resource', async () => {
    const { router } = routerWith(denyingGuard());

    await expect(call(router.assets.list, {}, { context: CTX })).rejects.toThrow(ORPCError);
    await expect(call(router.assets.create, { ...USDT_ERC20 }, { context: CTX })).rejects.toThrow(
      ORPCError,
    );
  });
});

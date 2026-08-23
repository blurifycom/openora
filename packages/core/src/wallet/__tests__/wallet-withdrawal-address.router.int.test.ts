import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, ORPCError } from '@orpc/server';
import { queue, type PaymentAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { CreateWithdrawalAddressInput } from '../contract/index.js';
import {
  mock,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
  makeIdentityReader,
  makeJobQueue,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { walletWithdrawalAddress } from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';
import type { ReconciliationService } from '../service/reconciliation.service.js';

const RECONCILIATION_QUEUE = queue('wallet-reconciliation');

const PLAYER = '9a2f7c11-0000-4000-8000-00000000a001';
const OTHER_PLAYER = '9a2f7c11-0000-4000-8000-00000000a002';
const ctxFor = (userId: string) => testContext({ auth: { userId } });

const LEDGER: CreateWithdrawalAddressInput = {
  label: 'My Ledger',
  currency: 'USDT',
  network: 'ERC20',
  address: '0x1111111111111111111111111111111111111111',
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(walletWithdrawalAddress);
});

function routerWith() {
  const audit = makeAuditWriter();
  const paymentProviders = makePaymentProviderRegistry({});
  const service = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({}),
    paymentProviders,
    audit,
    identityReader: makeIdentityReader(),
  });
  const router = createWalletRouter({
    wallet: service,
    adminGuard: makeAdminGuard({ caller: { userId: PLAYER, role: 'admin' } }),
    audit,
    paymentProviders,
    reconciliation: mock<ReconciliationService>({}),
    jobQueue: makeJobQueue(),
    reconciliationQueue: RECONCILIATION_QUEUE,
  });
  return { router, audit, service };
}

const create = (
  router: ReturnType<typeof routerWith>['router'],
  input: Partial<CreateWithdrawalAddressInput> = {},
  userId = PLAYER,
) => call(router.withdrawalAddresses.create, { ...LEDGER, ...input }, { context: ctxFor(userId) });

describe('wallet withdrawal address book', () => {
  it('create: persists, normalizes casing, trims, and audits without the address', async () => {
    const { router, audit } = routerWith();

    const saved = await create(router, {
      label: '  My Ledger  ',
      currency: 'usdt',
      network: 'erc20',
    });

    expect(saved).toMatchObject({
      label: 'My Ledger',
      currency: 'USDT',
      network: 'ERC20',
      address: LEDGER.address,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.withdrawal_address.created',
        actorType: 'player',
        actorId: PLAYER,
        after: { label: 'My Ledger', currency: 'USDT', network: 'ERC20' },
      }),
    );
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.objectContaining({ address: expect.anything() }) }),
    );
  });

  it('create: the same address twice is a conflict, not a duplicate row', async () => {
    const { router } = routerWith();
    await create(router);

    await expect(create(router, { label: 'Same wallet again' })).rejects.toThrow(ORPCError);
    expect(
      await call(router.withdrawalAddresses.list, {}, { context: ctxFor(PLAYER) }),
    ).toHaveLength(1);
  });

  it('create: the same address on another network is allowed', async () => {
    const { router } = routerWith();
    await create(router);

    const trc = await create(router, { network: 'TRC20' });

    expect(trc).toMatchObject({ network: 'TRC20' });
  });

  it("list: only the caller's own rows, newest first, filterable by currency", async () => {
    const { router } = routerWith();
    await create(router);
    await create(router, { label: 'My BTC', currency: 'BTC', network: 'SEGWIT' });
    await create(router, { label: 'Not yours' }, OTHER_PLAYER);

    const all = await call(router.withdrawalAddresses.list, {}, { context: ctxFor(PLAYER) });
    const btc = await call(
      router.withdrawalAddresses.list,
      { currency: 'btc' },
      { context: ctxFor(PLAYER) },
    );

    expect(all.map((a) => a.label)).toEqual(['My BTC', 'My Ledger']);
    expect(btc.map((a) => a.label)).toEqual(['My BTC']);
  });

  it("delete: removes the caller's own row and audits it", async () => {
    const { router, audit } = routerWith();
    const saved = await create(router);

    const deleted = await call(
      router.withdrawalAddresses.delete,
      { id: saved.id },
      { context: ctxFor(PLAYER) },
    );

    expect(deleted).toBe(true);
    expect(await call(router.withdrawalAddresses.list, {}, { context: ctxFor(PLAYER) })).toEqual(
      [],
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.withdrawal_address.deleted', actorId: PLAYER }),
    );
  });

  it('delete: another player cannot remove the row, and cannot tell it exists', async () => {
    const { router } = routerWith();
    const saved = await create(router);

    const deleted = await call(
      router.withdrawalAddresses.delete,
      { id: saved.id },
      { context: ctxFor(OTHER_PLAYER) },
    );
    const missing = await call(
      router.withdrawalAddresses.delete,
      { id: randomUUID() },
      { context: ctxFor(OTHER_PLAYER) },
    );

    expect(deleted).toBe(false);
    expect(missing).toBe(false);
    expect(
      await call(router.withdrawalAddresses.list, {}, { context: ctxFor(PLAYER) }),
    ).toHaveLength(1);
  });

  it('every route rejects an unauthenticated caller', async () => {
    const { router } = routerWith();

    await expect(
      call(router.withdrawalAddresses.list, {}, { context: testContext() }),
    ).rejects.toThrow(ORPCError);
    await expect(
      call(router.withdrawalAddresses.create, { ...LEDGER }, { context: testContext() }),
    ).rejects.toThrow(ORPCError);
    await expect(
      call(router.withdrawalAddresses.delete, { id: randomUUID() }, { context: testContext() }),
    ).rejects.toThrow(ORPCError);
  });

  it('create: rejects the 51st address', async () => {
    const { router, service } = routerWith();
    await db.drizzle.db.insert(walletWithdrawalAddress).values(
      Array.from({ length: 50 }, (_, i) => ({
        userId: PLAYER,
        label: `wallet ${i}`,
        currency: 'USDT',
        network: 'ERC20',
        address: `0x${String(i).padStart(40, '0')}`,
      })),
    );

    await expect(create(router)).rejects.toThrow(ORPCError);
    expect(await service.listWithdrawalAddresses(PLAYER)).toHaveLength(50);
  });
});

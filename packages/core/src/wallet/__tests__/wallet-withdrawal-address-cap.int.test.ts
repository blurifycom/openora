import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock, makeEventBus, makeAuditWriter, makeIdentityReader } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { walletWithdrawalAddress } from '../schema/index.js';
import {
  WalletService,
  WithdrawalAddressAlreadyExistsError,
  WithdrawalAddressLimitReachedError,
} from '../service/wallet.service.js';
import type { CreateWithdrawalAddressInput } from '../contract/index.js';
import type { PaymentAdapter } from '@openora/core/contracts';

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

function makeService() {
  return new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({}),
    paymentProviders: mock({}),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
  });
}

const addressInput = (i: number): CreateWithdrawalAddressInput => ({
  label: `wallet ${i}`,
  currency: 'USDT',
  network: 'ERC20',
  address: `0x${String(i).padStart(40, '0')}`,
});

describe('createWithdrawalAddress: the 50-row cap is enforced by the insert itself', () => {
  it('throws WithdrawalAddressLimitReachedError once the cap is reached, not a duplicate error', async () => {
    const svc = makeService();
    const userId = randomUUID();
    for (let i = 0; i < 50; i++) {
      await svc.createWithdrawalAddress(userId, addressInput(i));
    }

    await expect(svc.createWithdrawalAddress(userId, addressInput(50))).rejects.toBeInstanceOf(
      WithdrawalAddressLimitReachedError,
    );
    expect(await svc.listWithdrawalAddresses(userId)).toHaveLength(50);
  });

  it('throws WithdrawalAddressAlreadyExistsError for a duplicate, even under the cap', async () => {
    const svc = makeService();
    const userId = randomUUID();
    const input = addressInput(0);
    await svc.createWithdrawalAddress(userId, input);

    await expect(
      svc.createWithdrawalAddress(userId, { ...input, label: 'same wallet again' }),
    ).rejects.toBeInstanceOf(WithdrawalAddressAlreadyExistsError);
    expect(await svc.listWithdrawalAddresses(userId)).toHaveLength(1);
  });

  it('never lands more than 50 rows when many creates race the cap concurrently', async () => {
    const svc = makeService();
    const userId = randomUUID();
    const attempts = 60;

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) =>
        svc.createWithdrawalAddress(userId, addressInput(i)),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejectedWithCapError = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof WithdrawalAddressLimitReachedError,
    );

    expect(succeeded).toHaveLength(50);
    expect(rejectedWithCapError).toHaveLength(attempts - 50);
    expect(await svc.listWithdrawalAddresses(userId)).toHaveLength(50);
  });
});

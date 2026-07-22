import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import { mock } from '../../testing/mock.js';
import type { AdminGuard } from '@openora/core/server';
import type {
  AuditWritePort,
  PaymentAdapter,
  PaymentWebhookVerifier,
} from '@openora/core/contracts';
import { createWalletRouter } from '../router/index.js';
import type { WalletService } from '../service/wallet.service.js';

const CTX = { request: { headers: {} } };
const fakeAudit = (): AuditWritePort => mock<AuditWritePort>({ record: vi.fn() });
const fakePayment = (): PaymentAdapter => mock<PaymentAdapter>({});
const fakeWebhookVerifier = (): PaymentWebhookVerifier =>
  mock<PaymentWebhookVerifier>({ verify: vi.fn().mockReturnValue(false) });
const USER_ID = '63d3c264-3bf4-4d08-9b92-ea3eaf40a440';

function fakeWallet(): WalletService {
  return mock<WalletService>({
    getTransactions: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
  });
}

/** AdminGuard that denies the `transaction` resource, grants everything else. */
function fakeTransactionDenyingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async (_ctx: unknown, resource?: string) => {
      if (resource === 'transaction') {
        throw new ORPCError('FORBIDDEN', { message: 'Missing permission: transaction:view' });
      }
      return { userId: 'caller-1', role: 'support' };
    }),
  });
}

function fakeAllowingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async () => ({ userId: 'caller-1', role: 'admin' })),
  });
}

describe('wallet router listPlayerTransactions authz', () => {
  it('rejects a caller lacking transaction:view (IDOR guard)', async () => {
    const wallet = fakeWallet();
    const router = createWalletRouter(
      wallet,
      fakeTransactionDenyingGuard(),
      fakeAudit(),
      fakePayment(),
      fakeWebhookVerifier(),
    );

    await expect(
      call(
        router.listPlayerTransactions,
        { userId: USER_ID, page: 1, limit: 20 },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(wallet.getTransactions).not.toHaveBeenCalled();
  });

  it('allows a caller with transaction:view to read any player ledger', async () => {
    const wallet = fakeWallet();
    const router = createWalletRouter(
      wallet,
      fakeAllowingGuard(),
      fakeAudit(),
      fakePayment(),
      fakeWebhookVerifier(),
    );

    await call(
      router.listPlayerTransactions,
      { userId: USER_ID, page: 1, limit: 20 },
      { context: CTX },
    );

    expect(wallet.getTransactions).toHaveBeenCalledWith({
      userId: USER_ID,
      page: 1,
      limit: 20,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
  });
});

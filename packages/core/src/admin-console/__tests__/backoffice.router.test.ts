import { describe, it, expect, vi } from 'vitest';
import { mock, adminCaller, testContext } from '../../testing/mock.js';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { AuditWritePort } from '@openora/core/contracts';
import { createBackofficeRouter } from '../router/index.js';
import type { BackofficeService } from '../service/backoffice.service.js';

const CTX = testContext();
const USER_ID = '63d3c264-3bf4-4d08-9b92-ea3eaf40a440';

const USER = {
  id: USER_ID,
  email: 'p@example.com',
  name: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  isActive: true,
  role: 'player',
};

/** AdminGuard that only super-admins clear the `admin` resource; everyone clears `player`. */
function fakeGuard(opts: { isSuper: boolean }): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async (_ctx: unknown, resource?: string) => {
      if (resource === 'admin' && !opts.isSuper) {
        throw new ORPCError('FORBIDDEN', { message: 'Missing permission: admin:update' });
      }
      return adminCaller({ userId: 'caller-1', role: opts.isSuper ? 'admin' : 'support' });
    }),
  });
}

function fakeService(): BackofficeService {
  return mock<BackofficeService>({
    getUser: vi.fn().mockResolvedValue(USER),
    updateUser: vi.fn().mockResolvedValue({ ...USER, role: 'admin' }),
    listTransactions: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
    getTransaction: vi.fn().mockResolvedValue(null),
  });
}

/** AdminGuard that grants `player` ops but denies the `transaction` resource. */
function fakeTransactionDenyingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async (_ctx: unknown, resource?: string) => {
      if (resource === 'transaction') {
        throw new ORPCError('FORBIDDEN', { message: 'Missing permission: transaction:view' });
      }
      return adminCaller({ userId: 'caller-1', role: 'support' });
    }),
  });
}

function fakeAudit(): AuditWritePort {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

describe('backoffice router updateUser authz', () => {
  it('rejects a role change from a non-super-admin', async () => {
    const guard = fakeGuard({ isSuper: false });
    const router = createBackofficeRouter(fakeService(), guard, fakeAudit());
    await expect(
      call(router.updateUser, { userId: USER_ID, role: 'admin' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('allows a super-admin to change a role and writes an audit entry', async () => {
    const guard = fakeGuard({ isSuper: true });
    const audit = fakeAudit();
    const router = createBackofficeRouter(fakeService(), guard, audit);
    const result = await call(
      router.updateUser,
      { userId: USER_ID, role: 'admin' },
      { context: CTX },
    );
    expect(result.role).toBe('admin');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'admin',
        action: 'admin.user.updated',
        resourceType: 'user',
        resourceId: USER_ID,
      }),
    );
  });

  it('allows an isActive-only change without the super-admin gate and audits it', async () => {
    const guard = fakeGuard({ isSuper: false });
    const audit = fakeAudit();
    const router = createBackofficeRouter(fakeService(), guard, audit);
    await call(router.updateUser, { userId: USER_ID, isActive: false }, { context: CTX });
    expect(audit.record).toHaveBeenCalledOnce();
  });
});

describe('backoffice router transaction:view authz', () => {
  it('rejects listTransactions for a caller lacking transaction:view', async () => {
    const router = createBackofficeRouter(
      fakeService(),
      fakeTransactionDenyingGuard(),
      fakeAudit(),
    );
    await expect(
      call(router.listTransactions, { page: 1, limit: 20 }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects getTransaction for a caller lacking transaction:view', async () => {
    const router = createBackofficeRouter(
      fakeService(),
      fakeTransactionDenyingGuard(),
      fakeAudit(),
    );
    await expect(
      call(router.getTransaction, { id: USER_ID }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

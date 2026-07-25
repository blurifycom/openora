import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type {
  AdminUserDirectory,
  AdminUserRow,
  AdminWalletReporting,
} from '@openora/core/contracts';
import { mock, testContext, makeAuditWriter, makeAdminGuard } from '../../testing/mock.js';
import { createBackofficeRouter } from '../router/index.js';
import { BackofficeService } from '../service/backoffice.service.js';

const CTX = testContext();
const USER_ID = '63d3c264-3bf4-4d08-9b92-ea3eaf40a440';

function userRow(over: Partial<AdminUserRow> = {}): AdminUserRow {
  return mock<AdminUserRow>({
    id: USER_ID,
    email: 'p@example.com',
    name: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    isActive: true,
    role: 'player',
    ...over,
  });
}

function realService(over: { directory?: Partial<AdminUserDirectory> } = {}) {
  const stored = { row: userRow() };
  const users = mock<AdminUserDirectory>({
    count: vi.fn().mockResolvedValue(0),
    list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    get: vi.fn(async () => stored.row),
    update: vi.fn(async (_id: string, data: Partial<AdminUserRow>) => {
      const set = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
      stored.row = { ...stored.row, ...set };
      return stored.row;
    }),
    lookupPlayers: vi.fn().mockResolvedValue([]),
    findPlayerIds: vi.fn().mockResolvedValue([]),
    ...over.directory,
  });
  const reporting = mock<AdminWalletReporting>({
    totals: vi.fn().mockResolvedValue({ deposits: '0', withdrawals: '0' }),
    listTransactions: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    getTransaction: vi.fn().mockResolvedValue(null),
  });
  return { service: new BackofficeService(users, reporting), users, stored };
}

const guardWhereOnlySuperAdminClearsAdmin = (isSuper: boolean) =>
  makeAdminGuard({
    deny: isSuper ? [] : ['admin'],
    caller: { userId: 'caller-1', role: isSuper ? 'admin' : 'support' },
  });

const transactionDenyingGuard = () =>
  makeAdminGuard({ deny: ['transaction'], caller: { userId: 'caller-1', role: 'support' } });

const audit = makeAuditWriter;

describe('backoffice router updateUser authz', () => {
  it('rejects a role change from a non-super-admin and leaves the user untouched', async () => {
    const { service, users } = realService();
    const router = createBackofficeRouter(
      service,
      guardWhereOnlySuperAdminClearsAdmin(false),
      audit(),
    );

    await expect(
      call(router.updateUser, { userId: USER_ID, role: 'admin' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(users.update).not.toHaveBeenCalled();
  });

  it('allows a super-admin to change a role and writes the before/after audit entry', async () => {
    const { service } = realService();
    const writer = audit();
    const router = createBackofficeRouter(
      service,
      guardWhereOnlySuperAdminClearsAdmin(true),
      writer,
    );

    const result = await call(
      router.updateUser,
      { userId: USER_ID, role: 'admin' },
      { context: CTX },
    );

    expect(result.role).toBe('admin');
    expect(writer.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'admin',
        action: 'admin.user.updated',
        resourceType: 'user',
        resourceId: USER_ID,
        before: { isActive: true, role: 'player' },
        after: { isActive: true, role: 'admin' },
      }),
    );
  });

  it('allows an isActive-only change without the super-admin gate and audits it', async () => {
    const { service } = realService();
    const writer = audit();
    const router = createBackofficeRouter(
      service,
      guardWhereOnlySuperAdminClearsAdmin(false),
      writer,
    );

    const result = await call(
      router.updateUser,
      { userId: USER_ID, isActive: false },
      { context: CTX },
    );

    expect(result.isActive).toBe(false);
    expect(writer.record).toHaveBeenCalledOnce();
  });

  it('maps an unknown user to NOT_FOUND rather than a raw throw', async () => {
    const { service } = realService({ directory: { get: vi.fn().mockResolvedValue(null) } });
    const router = createBackofficeRouter(
      service,
      guardWhereOnlySuperAdminClearsAdmin(true),
      audit(),
    );

    await expect(
      call(router.updateUser, { userId: USER_ID, isActive: false }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serializes createdAt to an ISO string on the wire', async () => {
    const { service } = realService();
    const router = createBackofficeRouter(
      service,
      guardWhereOnlySuperAdminClearsAdmin(false),
      audit(),
    );

    const result = await call(
      router.updateUser,
      { userId: USER_ID, isActive: false },
      { context: CTX },
    );

    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('backoffice router transaction:view authz', () => {
  it('rejects listTransactions for a caller lacking transaction:view', async () => {
    const { service } = realService();
    const router = createBackofficeRouter(service, transactionDenyingGuard(), audit());

    await expect(
      call(router.listTransactions, { page: 1, limit: 20 }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects getTransaction for a caller lacking transaction:view', async () => {
    const { service } = realService();
    const router = createBackofficeRouter(service, transactionDenyingGuard(), audit());

    await expect(
      call(router.getTransaction, { id: USER_ID }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

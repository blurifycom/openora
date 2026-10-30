import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type {
  AdminGameReporting,
  AdminPlayerActivity,
  AdminRoleAssignmentDirectory,
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

function realService(
  over: {
    directory?: Partial<AdminUserDirectory>;
    /** What the in-transaction super-admin check answers; true = another one remains. */
    keepsAnotherActiveSuperAdmin?: boolean;
  } = {},
) {
  const stored = { row: userRow() };
  const writes: unknown[] = [];
  // Mirrors the real directory: beforeWrite sees the locked row and can veto the write.
  const update: AdminUserDirectory['update'] = async (_id, data, _actor, _meta, options) => {
    await options?.beforeWrite?.(TX, { isActive: stored.row.isActive, role: stored.row.role });
    const set = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    stored.row = { ...stored.row, ...set };
    writes.push(data);
    return stored.row;
  };
  const users = mock<AdminUserDirectory>({
    count: vi.fn().mockResolvedValue(0),
    list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    get: vi.fn(async () => stored.row),
    update: vi.fn(update),
    lookupPlayers: vi.fn().mockResolvedValue([]),
    findPlayerIds: vi.fn().mockResolvedValue([]),
    ...over.directory,
  });
  const reporting = mock<AdminWalletReporting>({
    totals: vi.fn().mockResolvedValue({ deposits: '0', withdrawals: '0' }),
    listTransactions: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    getTransaction: vi.fn().mockResolvedValue(null),
  });
  const gameReporting = mock<AdminGameReporting>({
    listGamePerformance: vi.fn().mockResolvedValue([]),
  });
  const playerActivity = mock<AdminPlayerActivity>({
    getRegistrationsOverTime: vi.fn().mockResolvedValue([]),
    getActiveUsersTrend: vi.fn().mockResolvedValue([]),
    getRetentionCohorts: vi.fn().mockResolvedValue([]),
  });
  const roleAssignments = mock<AdminRoleAssignmentDirectory>({
    listByUserIds: vi.fn().mockResolvedValue([]),
    keepsAnotherActiveSuperAdmin: vi
      .fn()
      .mockResolvedValue(over.keepsAnotherActiveSuperAdmin ?? true),
  });
  return {
    service: new BackofficeService(
      users,
      reporting,
      gameReporting,
      playerActivity,
      roleAssignments,
    ),
    users,
    stored,
    writes,
    roleAssignments,
  };
}

const TX = { kind: 'directory-transaction' };

const guardWhereOnlySuperAdminClearsAdmin = (isSuper: boolean) =>
  makeAdminGuard({
    deny: isSuper ? [] : ['admin'],
    superAdmin: isSuper,
    caller: { userId: 'caller-1', role: isSuper ? 'admin' : 'support' },
  });

// The seeded `admin` role in miniature: full player rights, not a super-admin.
const playerEditorGuard = () =>
  makeAdminGuard({ superAdmin: false, caller: { userId: 'caller-1', role: 'admin' } });

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

  it.each([
    ['disable', false],
    ['re-enable', true],
  ])(
    'refuses a player editor who tries to %s a staff account and leaves it untouched',
    async (_verb, isActive) => {
      const { service, users, stored } = realService();
      stored.row = userRow({ role: 'admin', isActive: !isActive });
      const writer = audit();
      const router = createBackofficeRouter(service, playerEditorGuard(), writer);

      await expect(
        call(router.updateUser, { userId: USER_ID, isActive }, { context: CTX }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(users.update).not.toHaveBeenCalled();
      expect(writer.record).not.toHaveBeenCalled();
    },
  );

  it('lets a player editor disable a player', async () => {
    const { service } = realService();
    const router = createBackofficeRouter(service, playerEditorGuard(), audit());

    const result = await call(
      router.updateUser,
      { userId: USER_ID, isActive: false },
      { context: CTX },
    );

    expect(result.isActive).toBe(false);
  });

  it('lets a super-admin disable and re-enable a staff account, auditing each change', async () => {
    const { service, stored } = realService();
    stored.row = userRow({ role: 'admin' });
    const writer = audit();
    const router = createBackofficeRouter(
      service,
      guardWhereOnlySuperAdminClearsAdmin(true),
      writer,
    );

    await call(router.updateUser, { userId: USER_ID, isActive: false }, { context: CTX });
    const result = await call(
      router.updateUser,
      { userId: USER_ID, isActive: true },
      { context: CTX },
    );

    expect(result.isActive).toBe(true);
    expect(writer.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actorId: 'caller-1',
        action: 'admin.user.updated',
        resourceId: USER_ID,
        before: { isActive: true, role: 'admin' },
        after: { isActive: false, role: 'admin' },
      }),
    );
    expect(writer.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        before: { isActive: false, role: 'admin' },
        after: { isActive: true, role: 'admin' },
      }),
    );
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

describe('backoffice router updateUser keeps admin management reachable', () => {
  const superGuard = (userId: string) =>
    makeAdminGuard({ superAdmin: true, caller: { userId, role: 'admin' } });

  async function attempt(
    patch: { isActive?: boolean; role?: 'admin' | 'player' },
    setup: Parameters<typeof realService>[0],
    callerId = 'caller-1',
  ) {
    const { service, stored, writes, roleAssignments } = realService(setup);
    stored.row = userRow({ role: 'admin' });
    const writer = audit();
    const router = createBackofficeRouter(service, superGuard(callerId), writer);
    const error = await call(
      router.updateUser,
      { userId: USER_ID, ...patch },
      { context: CTX },
    ).catch((err: unknown) => err);
    return { error, writes, writer, roleAssignments };
  }

  it.each([
    ['disable', { isActive: false }],
    ['demote', { role: 'player' as const }],
  ])('refuses a super-admin who tries to %s their own account', async (_verb, patch) => {
    const { error, writes, writer } = await attempt(patch, {}, USER_ID);

    expect(error).toMatchObject({ code: 'CONFLICT', data: { reason: 'self_lockout' } });
    expect(writes).toEqual([]);
    expect(writer.record).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', { isActive: false }],
    ['demoted', { role: 'player' as const }],
  ])('refuses the last active super-admin being %s, inside the write', async (_verb, patch) => {
    const { error, writes, roleAssignments } = await attempt(patch, {
      keepsAnotherActiveSuperAdmin: false,
    });

    expect(error).toMatchObject({
      code: 'CONFLICT',
      data: { reason: 'last_active_super_admin' },
    });
    expect(writes).toEqual([]);
    // The check joins the directory's own transaction, so it runs under the same lock as the write.
    expect(roleAssignments.keepsAnotherActiveSuperAdmin).toHaveBeenCalledWith(USER_ID, TX);
  });

  it('lets a super-admin disable another super-admin while an active one remains', async () => {
    const { error, writes } = await attempt({ isActive: false }, {});

    expect(error).not.toBeInstanceOf(Error);
    expect(writes).toEqual([{ isActive: false }]);
  });

  it('skips the super-admin check for a change that removes no access', async () => {
    const { error, roleAssignments } = await attempt(
      { isActive: true, role: 'admin' },
      {},
      USER_ID,
    );

    expect(error).not.toBeInstanceOf(Error);
    expect(roleAssignments.keepsAnotherActiveSuperAdmin).not.toHaveBeenCalled();
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

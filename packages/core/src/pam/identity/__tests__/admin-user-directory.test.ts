import { describe, it, expect, vi } from 'vitest';
import { mock, mockDb } from '../../../testing/mock.js';
import type { EventBus } from '@openora/core/server';
import { DrizzleAdminUserDirectory } from '../admin-user-directory.js';

function makeDir(existing: { isActive: boolean }) {
  const row = {
    id: 'u1',
    email: 'a@b.c',
    name: 'A',
    role: 'player',
    createdAt: new Date(0),
    isActive: existing.isActive,
  };
  const db = {
    select: () => ({ from: () => ({ where: async () => [row] }) }),
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: () => ({ returning: async () => [{ ...row, ...s }] }),
      }),
    }),
  };
  const emit = vi.fn();
  const dir = new DrizzleAdminUserDirectory(mockDb(db), mock<EventBus>({ emit }));
  return { dir, emit };
}

describe('DrizzleAdminUserDirectory.update active-status events', () => {
  it('emits identity.user.deactivated (with actor) when isActive flips true -> false', async () => {
    const { dir, emit } = makeDir({ isActive: true });
    await dir.update('u1', { isActive: false }, 'admin-1');
    expect(emit).toHaveBeenCalledWith('identity.user.deactivated', {
      userId: 'u1',
      actorId: 'admin-1',
      ip: null,
      userAgent: null,
    });
  });

  it('emits identity.user.reactivated (with actor) when isActive flips false -> true', async () => {
    const { dir, emit } = makeDir({ isActive: false });
    await dir.update('u1', { isActive: true }, 'admin-1');
    expect(emit).toHaveBeenCalledWith('identity.user.reactivated', {
      userId: 'u1',
      actorId: 'admin-1',
      ip: null,
      userAgent: null,
    });
  });

  it('does not emit when isActive is unchanged', async () => {
    const { dir, emit } = makeDir({ isActive: true });
    await dir.update('u1', { isActive: true }, 'admin-1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not emit on a role-only update', async () => {
    const { dir, emit } = makeDir({ isActive: true });
    await dir.update('u1', { role: 'admin' }, 'admin-1');
    expect(emit).not.toHaveBeenCalled();
  });
});

function makeDirWithSelect(rows: Record<string, unknown>[][]) {
  const queue = [...rows];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: async () => queue.shift() ?? [] }),
        where: () => ({ limit: async () => queue.shift() ?? [] }),
      }),
    }),
  };
  return new DrizzleAdminUserDirectory(mockDb(db), mock<EventBus>({ emit: vi.fn() }));
}

describe('DrizzleAdminUserDirectory.lookupPlayers', () => {
  it('returns an empty array for no ids without querying', async () => {
    const dir = makeDirWithSelect([]);
    expect(await dir.lookupPlayers([])).toEqual([]);
  });

  it('includes email joined from the user table and coerces unknown kyc to null', async () => {
    const dir = makeDirWithSelect([
      [{ userId: 'u1', username: 'alice', kycStatus: 'bogus', email: 'alice@example.com' }],
    ]);
    const [summary] = await dir.lookupPlayers(['u1']);
    expect(summary).toEqual({
      userId: 'u1',
      username: 'alice',
      email: 'alice@example.com',
      kycStatus: null,
    });
  });
});

describe('DrizzleAdminUserDirectory.findPlayerIds', () => {
  it('unions email + displayName matches into a deduped id set', async () => {
    const dir = makeDirWithSelect([
      [{ id: 'u1' }, { id: 'u2' }],
      [{ userId: 'u2' }, { userId: 'u3' }],
    ]);
    const ids = await dir.findPlayerIds('a');
    expect([...ids].sort()).toEqual(['u1', 'u2', 'u3']);
  });
});

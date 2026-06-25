import { describe, it, expect, vi } from 'vitest';
import type { DrizzleService, EventBus } from '@blurifycom/core/server';
import { DrizzleAdminUserDirectory } from '../admin-user-directory.js';

function makeDir(existing: { isActive: boolean }) {
  const row = {
    id: 'u1',
    email: 'a@b.c',
    name: 'A',
    role: 'user',
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
  const dir = new DrizzleAdminUserDirectory(
    { db } as unknown as DrizzleService,
    { emit } as unknown as EventBus,
  );
  return { dir, emit };
}

describe('DrizzleAdminUserDirectory.update active-status events', () => {
  it('emits identity.user.deactivated (with actor) when isActive flips true -> false', async () => {
    const { dir, emit } = makeDir({ isActive: true });
    await dir.update('u1', { isActive: false }, 'admin-1');
    expect(emit).toHaveBeenCalledWith('identity.user.deactivated', {
      userId: 'u1',
      actorId: 'admin-1',
    });
  });

  it('emits identity.user.reactivated (with actor) when isActive flips false -> true', async () => {
    const { dir, emit } = makeDir({ isActive: false });
    await dir.update('u1', { isActive: true }, 'admin-1');
    expect(emit).toHaveBeenCalledWith('identity.user.reactivated', {
      userId: 'u1',
      actorId: 'admin-1',
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

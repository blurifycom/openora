import { describe, expect, it, vi } from 'vitest';
import { ORPCError } from '@orpc/server';
import { adminCaller } from '../../../testing/mock.js';
import { authorizeWithAdminGuard } from '../authorize.js';

const ADMIN_ID = '8d1e7c0a-3f4b-4c2d-9e5f-6a7b8c9d0e1f';
const APPROVE = { resource: 'agent-proposal', action: 'approve' } as const;

const guardThat = (assertUser: () => Promise<never>) => ({ assertUser: vi.fn(assertUser) });

describe('authorizeWithAdminGuard', () => {
  it('allows when AdminGuard accepts the admin for the resource and action', async () => {
    const guard = { assertUser: vi.fn(async () => adminCaller({ userId: ADMIN_ID })) };

    await expect(authorizeWithAdminGuard(guard, ADMIN_ID, APPROVE)).resolves.toBe('allowed');
    expect(guard.assertUser).toHaveBeenCalledWith(ADMIN_ID, 'agent-proposal', 'approve');
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'])('denies on a %s refusal', async (code) => {
    const guard = guardThat(async () => {
      throw new ORPCError(code);
    });

    await expect(authorizeWithAdminGuard(guard, ADMIN_ID, APPROVE)).resolves.toBe('denied');
  });

  it('rethrows anything that is not a refusal, so the kernel fails closed', async () => {
    const outage = new Error('connection terminated');
    const guard = guardThat(async () => {
      throw outage;
    });

    await expect(authorizeWithAdminGuard(guard, ADMIN_ID, APPROVE)).rejects.toBe(outage);
  });

  it('rethrows a server-side oRPC error rather than treating it as a denial', async () => {
    const guard = guardThat(async () => {
      throw new ORPCError('INTERNAL_SERVER_ERROR');
    });

    await expect(authorizeWithAdminGuard(guard, ADMIN_ID, APPROVE)).rejects.toMatchObject({
      status: 500,
    });
  });
});

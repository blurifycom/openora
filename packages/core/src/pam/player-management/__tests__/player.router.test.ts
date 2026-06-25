import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@blurifycom/core/server';
import { createPlayerRouter } from '../router/index.js';
import type { PlayerService } from '../service/player.service.js';

const CTX = { request: { headers: {} } };
const PLAYER_ID = '63d3c264-3bf4-4d08-9b92-ea3eaf40a440';

function fakeGuard(allowed: ReadonlyArray<`${string}:${string}`>): AdminGuard {
  return {
    assert: vi.fn(async (_ctx: unknown, resource?: string, action?: string) => {
      if (resource && action && !allowed.includes(`${resource}:${action}`)) {
        throw new ORPCError('FORBIDDEN', { message: `Missing permission: ${resource}:${action}` });
      }
      return { userId: 'admin-1', role: 'admin' };
    }),
  } as unknown as AdminGuard;
}

function fakeService(): PlayerService {
  const playerDto = {
    id: PLAYER_ID,
    userId: PLAYER_ID,
    displayName: 'Player',
    email: 'p@example.com',
    country: 'MT',
    currency: 'EUR',
    language: 'en',
    status: 'active',
    kycStatus: 'verified',
    level: 1,
    totalWagered: 0,
    totalDeposits: 0,
    lastSeenAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return { update: vi.fn().mockResolvedValue(playerDto) } as unknown as PlayerService;
}

describe('player router update KYC authz', () => {
  it('rejects a kycStatus change without compliance:override-limit', async () => {
    const svc = fakeService();
    const router = createPlayerRouter(svc, fakeGuard(['player:update']));
    await expect(
      call(router.update, { playerId: PLAYER_ID, kycStatus: 'verified' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(svc.update).not.toHaveBeenCalled();
  });

  it('allows a kycStatus change with the compliance gate', async () => {
    const svc = fakeService();
    const router = createPlayerRouter(
      svc,
      fakeGuard(['player:update', 'compliance:override-limit']),
    );
    await call(router.update, { playerId: PLAYER_ID, kycStatus: 'verified' }, { context: CTX });
    expect(svc.update).toHaveBeenCalledWith(
      PLAYER_ID,
      expect.objectContaining({ kycStatus: 'verified' }),
      'admin-1',
    );
  });

  it('allows a non-KYC update with only player:update', async () => {
    const svc = fakeService();
    const router = createPlayerRouter(svc, fakeGuard(['player:update']));
    await call(router.update, { playerId: PLAYER_ID, displayName: 'New' }, { context: CTX });
    expect(svc.update).toHaveBeenCalledOnce();
  });
});

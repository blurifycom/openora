import { describe, it, expect, vi } from 'vitest';
import type { DrizzleService } from '@oss/db';
import type { EventBus } from '@oss/core';
import type { GameAdapter } from '@oss/adapters';
import {
  GamingService,
  GameNotFoundError,
  GameRoundNotFoundError,
} from '../service/gaming.service.js';

describe('GamingService domain errors', () => {
  it('GameNotFoundError carries the id', () => {
    const err = new GameNotFoundError('game-abc');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GameNotFoundError');
    expect(err.message).toContain('game-abc');
  });

  it('GameRoundNotFoundError carries the id', () => {
    const err = new GameRoundNotFoundError('round-xyz');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GameRoundNotFoundError');
    expect(err.message).toContain('round-xyz');
  });
});

// A query-chain spy: records that select/from/where/orderBy were called and resolves
// to `rows`. orderBy is the awaited terminal in listGames/listPublicGames.
function makeQueryChain(rows: unknown[]) {
  const calls = { where: undefined as unknown };
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn((clause: unknown) => {
      calls.where = clause;
      return chain;
    }),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  return { chain, calls };
}

const noopEvents = { emit: vi.fn(), on: vi.fn() } as unknown as EventBus;
const noopAdapter = {} as unknown as GameAdapter;

describe('GamingService lobby tenant scoping (ADR-0018/0019)', () => {
  it('listGames (authenticated) queries the RLS db, never adminDb', async () => {
    const rls = makeQueryChain([
      {
        id: 'g1',
        tenantId: 'tenant-a',
        name: 'Aces',
        provider: 'mock',
        category: 'slots',
        thumbnailUrl: null,
        isActive: true,
        metadata: null,
      },
    ]);
    const admin = makeQueryChain([]);
    const drizzle = { db: rls.chain, adminDb: admin.chain } as unknown as DrizzleService;
    const svc = new GamingService(drizzle, noopEvents, noopAdapter);

    const games = await svc.listGames('tenant-a');

    expect(games).toHaveLength(1);
    expect(rls.chain.select).toHaveBeenCalledOnce();
    // The authenticated path must NOT touch the BYPASSRLS admin db.
    expect(admin.chain.select).not.toHaveBeenCalled();
  });

  it('listPublicGames queries the BYPASSRLS adminDb with an explicit default-tenant filter', async () => {
    const rls = makeQueryChain([]);
    const admin = makeQueryChain([
      {
        id: 'g2',
        tenantId: 'default',
        name: 'Public Slot',
        provider: 'mock',
        category: 'slots',
        thumbnailUrl: null,
        isActive: true,
        metadata: null,
      },
    ]);
    const drizzle = { db: rls.chain, adminDb: admin.chain } as unknown as DrizzleService;
    const svc = new GamingService(drizzle, noopEvents, noopAdapter);

    const games = await svc.listPublicGames();

    expect(games).toHaveLength(1);
    // Public catalog reads go through adminDb (RLS would fail-closed with no GUC)...
    expect(admin.chain.select).toHaveBeenCalledOnce();
    // ...and never through the RLS db.
    expect(rls.chain.select).not.toHaveBeenCalled();
    // The filter is an explicit AND (isActive, tenantId = default) - the tenant is a
    // server-side constant, never client input. We assert a where-clause was applied.
    expect(admin.chain.where).toHaveBeenCalledOnce();
    expect(admin.calls.where).toBeDefined();
  });
});

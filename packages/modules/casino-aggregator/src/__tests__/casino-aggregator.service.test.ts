import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CasinoAggregatorService,
  AggregatorProviderNotFoundError,
} from '../service/casino-aggregator.service.js';

function makePrisma() {
  return {
    game: {
      upsert: vi.fn().mockResolvedValue({ id: 'game-1' }),
    },
    aggregatorProvider: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

function makeEvents() {
  return { emit: vi.fn() };
}

function makeProvider(
  games = [{ externalId: 'g1', name: 'Slots Mania', provider: 'mock', category: 'slots' }],
) {
  return {
    syncGameCatalog: vi.fn().mockResolvedValue({ games }),
    handleCallback: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CasinoAggregatorService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let events: ReturnType<typeof makeEvents>;
  let provider: ReturnType<typeof makeProvider>;
  let service: CasinoAggregatorService;

  beforeEach(() => {
    prisma = makePrisma();
    events = makeEvents();
    provider = makeProvider();
    service = new CasinoAggregatorService(prisma as never, events as never, provider as never);
  });

  describe('syncGames', () => {
    it('returns synced count from provider', async () => {
      const result = await service.syncGames('tenant-1');
      expect(result.synced).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('emits aggregator.sync.completed', async () => {
      await service.syncGames('tenant-1');
      expect(events.emit).toHaveBeenCalledWith(
        'aggregator.sync.completed',
        expect.objectContaining({ synced: 1, failed: 0, tenantId: 'tenant-1' }),
      );
    });

    it('counts failed when upsert throws', async () => {
      prisma.game.upsert.mockRejectedValueOnce(new Error('db error'));
      const result = await service.syncGames();
      expect(result.failed).toBe(1);
      expect(result.synced).toBe(0);
    });

    it('returns zero counts when no provider is injected', async () => {
      const serviceNoProvider = new CasinoAggregatorService(prisma as never, events as never, null);
      const result = await serviceNoProvider.syncGames();
      expect(result).toEqual({ synced: 0, failed: 0 });
    });
  });

  describe('listProviders', () => {
    it('returns empty array when no providers in db', async () => {
      const result = await service.listProviders();
      expect(result).toEqual([]);
    });

    it('maps db rows to summary shape', async () => {
      prisma.aggregatorProvider.findMany.mockResolvedValueOnce([
        {
          id: 'p1',
          tenantId: 't1',
          name: 'Softswiss',
          slug: 'softswiss',
          isActive: true,
          config: null,
          createdAt: new Date(),
        },
      ]);
      const result = await service.listProviders('t1');
      expect(result[0]).toMatchObject({
        id: 'p1',
        name: 'Softswiss',
        isActive: true,
        gameCount: 0,
      });
    });
  });

  describe('handleCallback', () => {
    it('delegates to provider and emits event', async () => {
      const result = await service.handleCallback('softswiss', 'round.completed', {
        roundId: 'r1',
      });
      expect(result).toEqual({ ok: true });
      expect(provider.handleCallback).toHaveBeenCalledWith('round.completed', { roundId: 'r1' });
      expect(events.emit).toHaveBeenCalledWith(
        'aggregator.callback.received',
        expect.objectContaining({ provider: 'softswiss', event: 'round.completed' }),
      );
    });
  });

  describe('AggregatorProviderNotFoundError', () => {
    it('carries the slug', () => {
      const err = new AggregatorProviderNotFoundError('missing-slug');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('AggregatorProviderNotFoundError');
      expect(err.message).toContain('missing-slug');
    });
  });
});

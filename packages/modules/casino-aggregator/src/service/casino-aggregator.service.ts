import { Injectable, Inject, Optional } from '@nestjs/common';
import { type EventBus, EVENT_BUS } from '@oss/core';
import { PrismaService } from '@oss/persistence';
import { type AggregatorProvider, AGGREGATOR_PROVIDER } from './ports.js';

type SyncResult = { synced: number; failed: number };
type AggregatorProviderSummary = { id: string; name: string; isActive: boolean; gameCount: number };

export class AggregatorProviderNotFoundError extends Error {
  constructor(slug: string) {
    super(`Aggregator provider not found: ${slug}`);
    this.name = 'AggregatorProviderNotFoundError';
  }
}

type PrismaWithGame = PrismaService & {
  game: {
    upsert: (args: {
      where: { id: string };
      create: {
        tenantId: string;
        name: string;
        provider: string;
        category: string;
        thumbnailUrl?: string | null;
        metadata?: Record<string, unknown> | null;
        isActive: boolean;
      };
      update: {
        name: string;
        provider: string;
        category: string;
        thumbnailUrl?: string | null;
        metadata?: Record<string, unknown> | null;
      };
    }) => Promise<{ id: string }>;
  };
  aggregatorProvider: {
    findMany: (args: { where: { tenantId?: string }; orderBy: { createdAt: string } }) => Promise<
      Array<{
        id: string;
        tenantId: string;
        name: string;
        slug: string;
        isActive: boolean;
        config: unknown;
        createdAt: Date;
      }>
    >;
  };
};

@Injectable()
export class CasinoAggregatorService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Optional() @Inject(AGGREGATOR_PROVIDER) private readonly provider: AggregatorProvider | null,
  ) {}

  async syncGames(tenantId?: string): Promise<SyncResult> {
    if (!this.provider) {
      return { synced: 0, failed: 0 };
    }

    const { games } = await this.provider.syncGameCatalog();

    let synced = 0;
    let failed = 0;
    const prismaWithGame = this.prisma as unknown as PrismaWithGame;
    const effectiveTenantId = tenantId ?? 'default';

    for (const game of games) {
      try {
        await prismaWithGame.game.upsert({
          where: { id: game.externalId },
          create: {
            tenantId: effectiveTenantId,
            name: game.name,
            provider: game.provider,
            category: game.category,
            thumbnailUrl: game.thumbnailUrl ?? null,
            metadata: game.metadata ?? null,
            isActive: true,
          },
          update: {
            name: game.name,
            provider: game.provider,
            category: game.category,
            thumbnailUrl: game.thumbnailUrl ?? null,
            metadata: game.metadata ?? null,
          },
        });
        synced++;
      } catch {
        failed++;
      }
    }

    this.events.emit('aggregator.sync.completed', { synced, failed, tenantId: effectiveTenantId });
    return { synced, failed };
  }

  async listProviders(tenantId?: string): Promise<AggregatorProviderSummary[]> {
    const prismaWithAggregator = this.prisma as unknown as PrismaWithGame;
    const providers = await prismaWithAggregator.aggregatorProvider.findMany({
      where: tenantId ? { tenantId } : {},
      orderBy: { createdAt: 'asc' },
    });

    return providers.map((p) => ({
      id: p.id,
      name: p.name,
      isActive: p.isActive,
      gameCount: 0,
    }));
  }

  async handleCallback(provider: string, event: string, payload: unknown): Promise<{ ok: true }> {
    if (this.provider) {
      await this.provider.handleCallback(event, payload);
    }
    this.events.emit('aggregator.callback.received', { provider, event });
    return { ok: true };
  }
}

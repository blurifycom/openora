import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { NO_CLIENT_META, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { gameProvider, gameProviderAggregatorMapping } from '../schema/index.js';
import {
  GameProviderService,
  GameProviderNotFoundError,
  GameProviderSlugTakenError,
  GameProviderVendorIdTakenError,
} from '../service/game-provider.service.js';

let db: TestDb;

const ACTOR = { actorId: '00000000-0000-4000-8000-000000000001', ...NO_CLIENT_META };

function makeService() {
  const events = makeEventBus();
  return { svc: new GameProviderService(db.drizzle, events), events };
}

async function seedProvider(
  overrides: Partial<typeof gameProvider.$inferInsert> = {},
  mappings: Array<{ aggregator: string; vendorId: string }> = [],
) {
  const [row] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `studio-${randomUUID()}`, name: 'Studio', ...overrides })
    .returning();
  if (mappings.length > 0) {
    await db.drizzle.db
      .insert(gameProviderAggregatorMapping)
      .values(mappings.map((mapping) => ({ providerId: row!.id, ...mapping })));
  }
  return row!;
}

const emittedTopics = (events: ReturnType<typeof makeEventBus>) =>
  events.emit.mock.calls.map(([topic]) => topic);

async function waitForLockWaiters(pool: Pool, expected: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.waiting ?? 0) >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} blocked database sessions`);
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${gameProvider} RESTART IDENTITY CASCADE`);
});

describe('GameProviderService (real PG)', () => {
  it('listActiveProviders returns only active providers, ordered by name, as summaries', async () => {
    await seedProvider({ slug: 'zeta-studio', name: 'Zeta', isActive: true });
    await seedProvider({ slug: 'alpha-studio', name: 'Alpha', isActive: true });
    await seedProvider({ slug: 'retired-studio', name: 'Retired', isActive: false });

    const { svc } = makeService();
    const rows = await svc.listActiveProviders();

    expect(rows.map((r) => r.slug)).toEqual(['alpha-studio', 'zeta-studio']);
    expect(rows[0]).toEqual({
      id: expect.any(String),
      slug: 'alpha-studio',
      name: 'Alpha',
      logoUrl: null,
    });
  });

  it('listProvidersAdmin paginates with totals', async () => {
    await seedProvider({ name: 'B' });
    await seedProvider({ name: 'A' });
    await seedProvider({ name: 'C' });

    const { svc } = makeService();
    const page = await svc.listProvidersAdmin({ page: 1, limit: 2 });

    expect(page.total).toBe(3);
    expect(page.page).toBe(1);
    expect(page.limit).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ name: 'A' });
  });

  it('listProvidersAdmin filters by q across name and slug, and by isActive', async () => {
    await seedProvider({ slug: 'pragmatic-play', name: 'Pragmatic Play', isActive: true });
    await seedProvider({ slug: 'old-studio', name: 'Old Studio', isActive: false });

    const { svc } = makeService();
    expect((await svc.listProvidersAdmin({ page: 1, limit: 10, q: 'pragma' })).total).toBe(1);
    expect((await svc.listProvidersAdmin({ page: 1, limit: 10, q: 'old-studio' })).total).toBe(1);
    expect((await svc.listProvidersAdmin({ page: 1, limit: 10, isActive: false })).total).toBe(1);
  });

  it('getProvider returns the detail row and 404s an unknown id', async () => {
    const created = await seedProvider({ slug: 'acme', isActive: true }, [
      { aggregator: 'aggregation-a', vendorId: 'vendor-7' },
    ]);
    const { svc } = makeService();

    expect(await svc.getProvider(created.id)).toMatchObject({
      slug: 'acme',
      aggregatorMappings: [{ aggregator: 'aggregation-a', vendorId: 'vendor-7' }],
      isActive: true,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    await expect(svc.getProvider('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      GameProviderNotFoundError,
    );
  });

  it('getActiveProviderBySlug resolves only an active provider by slug', async () => {
    await seedProvider({ slug: 'acme', name: 'Acme', isActive: true });
    await seedProvider({ slug: 'retired', name: 'Retired', isActive: false });
    const { svc } = makeService();

    await expect(svc.getActiveProviderBySlug('acme')).resolves.toMatchObject({
      slug: 'acme',
      name: 'Acme',
    });
    await expect(svc.getActiveProviderBySlug('retired')).rejects.toBeInstanceOf(
      GameProviderNotFoundError,
    );
    await expect(svc.getActiveProviderBySlug('unknown')).rejects.toBeInstanceOf(
      GameProviderNotFoundError,
    );
  });

  it('updateProvider renames, retires, and emits an event', async () => {
    const created = await seedProvider({ slug: 'acme', name: 'Acme' });
    const { svc, events } = makeService();

    const updated = await svc.updateProvider({
      id: created.id,
      name: 'Acme Studios',
      logoUrl: 'https://img.test/acme.png',
      isActive: false,
      ...ACTOR,
    });

    expect(updated).toMatchObject({ slug: 'acme', name: 'Acme Studios', isActive: false });
    expect(emittedTopics(events)).toContain('gaming.provider.updated');
  });

  it('round-trips the operator metadata blob through create, update, and read', async () => {
    const { svc, events } = makeService();

    const created = await svc.createProvider({
      slug: 'metadata-studio',
      name: 'Metadata Studio',
      metadata: { launchHost: 'https://games.example.test' },
      ...ACTOR,
    });
    expect(created).toMatchObject({ metadata: { launchHost: 'https://games.example.test' } });
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.provider.created',
      expect.objectContaining({ metadata: { launchHost: 'https://games.example.test' } }),
    );

    const replaced = await svc.updateProvider({
      id: created.id,
      metadata: { launchHost: 'https://cdn.example.test' },
      ...ACTOR,
    });
    expect(replaced).toMatchObject({ metadata: { launchHost: 'https://cdn.example.test' } });

    const untouched = await svc.updateProvider({ id: created.id, name: 'Renamed', ...ACTOR });
    expect(untouched).toMatchObject({ metadata: { launchHost: 'https://cdn.example.test' } });

    const cleared = await svc.updateProvider({ id: created.id, metadata: null, ...ACTOR });
    expect(cleared.metadata).toBeNull();
    expect((await svc.getProvider(created.id)).metadata).toBeNull();
  });

  it('createProvider persists multiple aggregator mappings and emits the audited snapshot', async () => {
    const { svc, events } = makeService();

    const created = await svc.createProvider({
      slug: 'multi-rail-studio',
      name: 'Multi Rail Studio',
      aggregatorMappings: [
        { aggregator: 'aggregation-b', vendorId: '42' },
        { aggregator: 'aggregation-a', vendorId: '42' },
      ],
      ...ACTOR,
    });

    expect(created).toMatchObject({
      slug: 'multi-rail-studio',
      isActive: false,
      aggregatorMappings: [
        { aggregator: 'aggregation-a', vendorId: '42' },
        { aggregator: 'aggregation-b', vendorId: '42' },
      ],
    });
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.provider.created',
      expect.objectContaining({
        providerId: created.id,
        aggregatorMappings: created.aggregatorMappings,
        isActive: false,
      }),
    );
  });

  it('createProvider maps slug and aggregator-scoped vendor collisions to distinct errors', async () => {
    await seedProvider({ slug: 'existing-studio' }, [
      { aggregator: 'aggregation-a', vendorId: 'vendor-1' },
    ]);
    const { svc } = makeService();

    await expect(
      svc.createProvider({ slug: 'existing-studio', name: 'Duplicate', ...ACTOR }),
    ).rejects.toBeInstanceOf(GameProviderSlugTakenError);
    await expect(
      svc.createProvider({
        slug: 'new-studio',
        name: 'New Studio',
        aggregatorMappings: [{ aggregator: 'aggregation-a', vendorId: 'vendor-1' }],
        ...ACTOR,
      }),
    ).rejects.toBeInstanceOf(GameProviderVendorIdTakenError);
  });

  it('updateProvider accepts a slug change but rejects a taken one', async () => {
    const a = await seedProvider({ slug: 'studio-a' });
    await seedProvider({ slug: 'studio-b' });
    const { svc } = makeService();

    await expect(
      svc.updateProvider({ id: a.id, slug: 'studio-a2', ...NO_CLIENT_META }),
    ).resolves.toMatchObject({
      slug: 'studio-a2',
    });
    await expect(
      svc.updateProvider({ id: a.id, slug: 'studio-b', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(GameProviderSlugTakenError);
    await expect(
      svc.updateProvider({
        id: '00000000-0000-4000-8000-000000000000',
        name: 'X',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(GameProviderNotFoundError);
  });

  it('updateProvider replaces mappings and rejects a vendor ID taken within the same aggregator', async () => {
    await seedProvider({ slug: 'studio-a' }, [
      { aggregator: 'aggregation-a', vendorId: 'vendor-1' },
    ]);
    const b = await seedProvider({ slug: 'studio-b' });
    const { svc, events } = makeService();

    await expect(
      svc.updateProvider({
        id: b.id,
        aggregatorMappings: [{ aggregator: 'aggregation-b', vendorId: 'vendor-1' }],
        ...ACTOR,
      }),
    ).resolves.toMatchObject({
      aggregatorMappings: [{ aggregator: 'aggregation-b', vendorId: 'vendor-1' }],
    });

    const attempt = svc.updateProvider({
      id: b.id,
      aggregatorMappings: [{ aggregator: 'aggregation-a', vendorId: 'vendor-1' }],
      ...ACTOR,
    });
    await expect(attempt).rejects.toBeInstanceOf(GameProviderVendorIdTakenError);
    await expect(attempt).rejects.not.toBeInstanceOf(GameProviderSlugTakenError);

    await expect(
      svc.updateProvider({ id: b.id, aggregatorMappings: [], ...ACTOR }),
    ).resolves.toMatchObject({ aggregatorMappings: [] });
    expect(events.emit).toHaveBeenLastCalledWith(
      'gaming.provider.updated',
      expect.objectContaining({
        before: expect.objectContaining({
          aggregatorMappings: [{ aggregator: 'aggregation-b', vendorId: 'vendor-1' }],
        }),
        after: expect.objectContaining({ aggregatorMappings: [] }),
      }),
    );
  });

  it('treats a supplied mapping collection as a replacement command', async () => {
    const created = await seedProvider({ slug: 'replace-studio' }, [
      { aggregator: 'aggregation-a', vendorId: 'vendor-1' },
    ]);
    const { svc, events } = makeService();
    const [before] = await db.drizzle.db
      .select({ id: gameProviderAggregatorMapping.id })
      .from(gameProviderAggregatorMapping)
      .where(eq(gameProviderAggregatorMapping.providerId, created.id));

    const result = await svc.updateProvider({
      id: created.id,
      aggregatorMappings: [{ aggregator: 'aggregation-a', vendorId: 'vendor-1' }],
      ...ACTOR,
    });
    const [after] = await db.drizzle.db
      .select({ id: gameProviderAggregatorMapping.id })
      .from(gameProviderAggregatorMapping)
      .where(eq(gameProviderAggregatorMapping.providerId, created.id));

    expect(result.aggregatorMappings).toEqual([
      { aggregator: 'aggregation-a', vendorId: 'vendor-1' },
    ]);
    expect(after?.id).not.toBe(before?.id);
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.provider.updated',
      expect.objectContaining({
        before: expect.objectContaining({ aggregatorMappings: result.aggregatorMappings }),
        after: expect.objectContaining({ aggregatorMappings: result.aggregatorMappings }),
      }),
    );
  });

  it('serializes concurrent updates into truthful returned states and audit transitions', async () => {
    const created = await seedProvider({ slug: 'serialized-studio', name: 'Initial Studio' }, [
      { aggregator: 'aggregation-a', vendorId: 'vendor-1' },
    ]);
    const { svc, events } = makeService();
    const controlPool = new Pool({ connectionString: db.url });
    const lockClient = await controlPool.connect();

    await lockClient.query('BEGIN');
    await lockClient.query('SELECT id FROM game_provider WHERE id = $1 FOR UPDATE', [created.id]);

    const firstUpdate = svc.updateProvider({
      id: created.id,
      name: 'First Studio',
      aggregatorMappings: [{ aggregator: 'aggregation-b', vendorId: 'vendor-2' }],
      ...ACTOR,
    });
    await waitForLockWaiters(controlPool, 1);
    const secondUpdate = svc.updateProvider({
      id: created.id,
      logoUrl: 'https://img.test/final.png',
      aggregatorMappings: [{ aggregator: 'aggregation-c', vendorId: 'vendor-3' }],
      ...ACTOR,
    });
    await waitForLockWaiters(controlPool, 2);
    await lockClient.query('COMMIT');
    lockClient.release();

    const [first, second] = await Promise.all([firstUpdate, secondUpdate]);
    await controlPool.end();

    expect(first).toMatchObject({
      name: 'First Studio',
      logoUrl: null,
      aggregatorMappings: [{ aggregator: 'aggregation-b', vendorId: 'vendor-2' }],
    });
    expect(second).toMatchObject({
      name: 'First Studio',
      logoUrl: 'https://img.test/final.png',
      aggregatorMappings: [{ aggregator: 'aggregation-c', vendorId: 'vendor-3' }],
    });
    expect(events.emit).toHaveBeenNthCalledWith(
      1,
      'gaming.provider.updated',
      expect.objectContaining({
        before: expect.objectContaining({
          name: 'Initial Studio',
          aggregatorMappings: [{ aggregator: 'aggregation-a', vendorId: 'vendor-1' }],
        }),
        after: expect.objectContaining({
          name: 'First Studio',
          aggregatorMappings: [{ aggregator: 'aggregation-b', vendorId: 'vendor-2' }],
        }),
      }),
    );
    expect(events.emit).toHaveBeenNthCalledWith(
      2,
      'gaming.provider.updated',
      expect.objectContaining({
        before: expect.objectContaining({
          name: 'First Studio',
          aggregatorMappings: [{ aggregator: 'aggregation-b', vendorId: 'vendor-2' }],
        }),
        after: expect.objectContaining({
          logoUrl: 'https://img.test/final.png',
          aggregatorMappings: [{ aggregator: 'aggregation-c', vendorId: 'vendor-3' }],
        }),
      }),
    );
  });
});

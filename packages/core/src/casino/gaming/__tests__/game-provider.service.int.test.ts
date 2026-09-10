import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { NO_CLIENT_META, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { gameProvider } from '../schema/index.js';
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

async function seedProvider(overrides: Partial<typeof gameProvider.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `studio-${randomUUID()}`, name: 'Studio', ...overrides })
    .returning();
  return row!;
}

const emittedTopics = (events: ReturnType<typeof makeEventBus>) =>
  events.emit.mock.calls.map(([topic]) => topic);

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
    const created = await seedProvider({
      slug: 'acme',
      aggregatorVendorId: 'vendor-7',
      isActive: true,
    });
    const { svc } = makeService();

    expect(await svc.getProvider(created.id)).toMatchObject({
      slug: 'acme',
      aggregatorVendorId: 'vendor-7',
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

  it('updateProvider rejects a taken aggregatorVendorId with its own error, not a slug one', async () => {
    await seedProvider({ slug: 'studio-a', aggregatorVendorId: 'vendor-1' });
    const b = await seedProvider({ slug: 'studio-b' });
    const { svc } = makeService();

    const attempt = svc.updateProvider({
      id: b.id,
      aggregatorVendorId: 'vendor-1',
      ...NO_CLIENT_META,
    });
    await expect(attempt).rejects.toBeInstanceOf(GameProviderVendorIdTakenError);
    await expect(attempt).rejects.not.toBeInstanceOf(GameProviderSlugTakenError);
  });
});

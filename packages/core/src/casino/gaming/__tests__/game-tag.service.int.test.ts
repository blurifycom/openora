import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { NO_CLIENT_META, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameProvider, gameTag, gameTagGame } from '../schema/index.js';
import {
  GameTagNameTakenError,
  GameTagNotFoundError,
  GameTagService,
  GameTagSystemDeletionError,
  GameTagSystemTypeChangeError,
} from '../service/game-tag.service.js';

let db: TestDb;

const ACTOR = { actorId: '00000000-0000-4000-8000-000000000001', ...NO_CLIENT_META };

function makeService() {
  const events = makeEventBus();
  return { svc: new GameTagService(db.drizzle, events), events };
}

async function seedTag(overrides: Partial<typeof gameTag.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameTag)
    .values({ name: `Tag ${randomUUID()}`, ...overrides })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game tag');
  }
  return row;
}

async function seedGame() {
  const [provider] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `provider-${randomUUID()}`, name: 'Provider' })
    .returning();
  if (!provider) {
    throw new Error('failed to seed a game provider');
  }
  const [record] = await db.drizzle.db
    .insert(game)
    .values({
      name: 'Game',
      slug: `game-${randomUUID()}`,
      providerId: provider.id,
      aggregator: 'direct',
    })
    .returning();
  if (!record) {
    throw new Error('failed to seed a game');
  }
  return record;
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
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameTagGame}, ${gameTag}, ${game}, ${gameProvider} RESTART IDENTITY CASCADE`,
  );
});

describe('GameTagService (real PG)', () => {
  it('creates a tag with the requested values and emits an event', async () => {
    const { svc, events } = makeService();

    const created = await svc.createTag({
      name: 'Featured',
      type: 'custom',
      visibility: 'invisible',
      ...ACTOR,
    });

    expect(created).toMatchObject({
      name: 'Featured',
      type: 'custom',
      visibility: 'invisible',
      badgeSettings: { badgeColor: '#3377ff', textColor: '#ffffff' },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(emittedTopics(events)).toContain('gaming.tag.created');
  });

  it('lists tags for admins with search and enum filters', async () => {
    await seedTag({ name: 'Visible Custom', type: 'custom', visibility: 'visible' });
    await seedTag({ name: 'Invisible System', type: 'system', visibility: 'invisible' });

    const { svc } = makeService();

    expect(
      (await svc.listTagsAdmin({ page: 1, limit: 10, q: 'visible', type: 'custom' })).items,
    ).toHaveLength(1);
    expect(
      (await svc.listTagsAdmin({ page: 1, limit: 10, visibility: 'invisible' })).items.map(
        (tag) => tag.name,
      ),
    ).toEqual(['Invisible System']);
  });

  it('updates a tag and rejects a duplicate name', async () => {
    const existing = await seedTag({ name: 'Existing' });
    const other = await seedTag({ name: 'Other' });
    const { svc, events } = makeService();

    const updated = await svc.updateTag({
      id: existing.id,
      name: 'Renamed',
      type: 'system',
      visibility: 'visible',
      badgeSettings: { badgeColor: '#112233', textColor: '#abcdef' },
      ...ACTOR,
    });

    expect(updated).toMatchObject({
      id: existing.id,
      name: 'Renamed',
      type: 'system',
      visibility: 'visible',
      badgeSettings: { badgeColor: '#112233', textColor: '#abcdef' },
    });
    expect(emittedTopics(events)).toContain('gaming.tag.updated');
    await expect(
      svc.updateTag({ id: other.id, name: 'Renamed', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(GameTagNameTakenError);
  });

  it('deletes custom tags and refuses system tag deletion', async () => {
    const custom = await seedTag({ name: 'Custom', type: 'custom' });
    const system = await seedTag({ name: 'System', type: 'system' });
    const linkedGame = await seedGame();
    await db.drizzle.db.insert(gameTagGame).values({ gameId: linkedGame.id, tagId: custom.id });
    const { svc, events } = makeService();

    await expect(svc.deleteTag({ id: system.id, ...ACTOR })).rejects.toBeInstanceOf(
      GameTagSystemDeletionError,
    );
    await expect(svc.updateTag({ id: system.id, type: 'custom', ...ACTOR })).rejects.toBeInstanceOf(
      GameTagSystemTypeChangeError,
    );
    await expect(svc.getTag(system.id)).resolves.toMatchObject({ name: 'System' });

    await expect(svc.deleteTag({ id: custom.id, ...ACTOR })).resolves.toBe(true);
    await expect(svc.getTag(custom.id)).rejects.toBeInstanceOf(GameTagNotFoundError);
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.tag.deleted',
      expect.objectContaining({
        tagId: custom.id,
        after: { deleted: true, affectedGameIds: [linkedGame.id] },
      }),
    );
  });
});

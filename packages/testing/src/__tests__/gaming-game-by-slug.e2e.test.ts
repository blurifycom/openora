import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DRIZZLE, type Container, type CoreTokenCatalog } from '@openora/core/server';
import { game, gameProvider } from '@openora/core/casino/schema/gaming';
import { type TestDb, type TestApp, bootE2e, closeE2e } from '../index.js';

let db: TestDb;
let app: TestApp;
let playableSlug: string;
let playableId: string;
let inactiveSlug: string;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

function drizzleOf(container: Container<CoreTokenCatalog>) {
  return container.get(DRIZZLE).db;
}

beforeAll(async () => {
  ({ db, app } = await bootE2e());

  const suffix = randomUUID().slice(0, 8);
  const [provider] = await drizzleOf(app.container)
    .insert(gameProvider)
    .values({
      slug: `e2e-by-slug-provider-${suffix}`,
      name: 'E2E By Slug Provider',
      isActive: true,
    })
    .returning();
  if (!provider) {
    throw new Error('failed to seed the provider');
  }
  playableSlug = `e2e-by-slug-game-${suffix}`;
  inactiveSlug = `e2e-by-slug-inactive-${suffix}`;
  const [playable] = await drizzleOf(app.container)
    .insert(game)
    .values([
      {
        reviewStatus: 'approved',
        name: 'E2E By Slug Game',
        slug: playableSlug,
        providerId: provider.id,
        aggregator: 'direct',
        isActive: true,
      },
      {
        reviewStatus: 'approved',
        name: 'E2E By Slug Inactive',
        slug: inactiveSlug,
        providerId: provider.id,
        aggregator: 'direct',
        isActive: false,
      },
    ])
    .returning();
  if (!playable) {
    throw new Error('failed to seed the games');
  }
  playableId = playable.id;
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('gaming getGameBySlug e2e', () => {
  it('returns the same game getGame returns for its id', async () => {
    const res = await app.app.request(`/gaming/games/by-slug/${playableSlug}`);
    expect(res.status).toBe(200);
    const bySlug = await readJson(res);
    expect(bySlug).toMatchObject({ id: playableId, slug: playableSlug, name: 'E2E By Slug Game' });

    const byId = await readJson(await app.app.request(`/gaming/games/${playableId}`));
    expect(bySlug).toEqual(byId);
  });

  it('404s an inactive game and an unknown slug, and 400s a malformed one', async () => {
    const inactive = await app.app.request(`/gaming/games/by-slug/${inactiveSlug}`);
    expect(inactive.status).toBe(404);

    const unknown = await app.app.request(`/gaming/games/by-slug/no-such-game-${randomUUID()}`);
    expect(unknown.status).toBe(404);

    const malformed = await app.app.request('/gaming/games/by-slug/Not_A_Slug');
    expect(malformed.status).toBe(400);
  });
});

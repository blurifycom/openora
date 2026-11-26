import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { featuredSlot, lobbyCategory, lobbySection } from '@openora/core/casino/schema/lobby';
import { asAdmin, bootE2e, closeE2e, newPlayer, type E2e, type TestClient } from '../index.js';
import { bodyOf, newGame } from './support/casino.js';

type LobbyE2e = E2e & { admin: TestClient };

let e2e: LobbyE2e;

beforeAll(async () => {
  const booted = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-lobby-category-section',
        path: fileURLToPath(
          new URL('./support/test-lobby-category-section-plugin.ts', import.meta.url),
        ),
      },
    ],
  });
  try {
    e2e = { ...booted, admin: await asAdmin(booted.app.app) };
  } catch (err) {
    await closeE2e(booted);
    throw err;
  }
}, 120_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const ErrorSchema = z.object({ code: z.string(), status: z.number() });
const ResolvedLayoutSchema = z.array(
  z.object({ id: z.string(), type: z.string(), data: z.record(z.string(), z.unknown()) }),
);
const AdminLayoutSchema = z.object({
  version: z.number(),
  sections: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      sortOrder: z.number(),
      config: z.record(z.string(), z.unknown()),
    }),
  ),
});
const GamesSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const FeaturedSchema = z.array(z.object({ gameId: z.string() }));

const adminLayout = async () => {
  const res = await e2e.admin.get('/backoffice/lobby/layout');
  expect(res.status).toBe(200);
  return AdminLayoutSchema.parse(await bodyOf(res));
};

const replaceLayout = (version: number, sections: unknown[]) =>
  e2e.admin.put('/backoffice/lobby/layout', { version, sections });

const note = (title: string) => ({ type: 'test-note', config: { title } });

const publicTitles = async (path: string) => {
  const res = await e2e.app.app.request(path);
  expect(res.status).toBe(200);
  return ResolvedLayoutSchema.parse(await bodyOf(res)).map((section) => section.data['title']);
};

async function newLobbyCategory() {
  const [created] = await db()
    .insert(lobbyCategory)
    .values({ name: 'Lobby Cat', slug: `lobby-cat-${randomUUID()}` })
    .returning();
  if (!created) {
    throw new Error('lobby category seed failed');
  }
  return created;
}

describe('lobby layout and sections', () => {
  it('an admin replaces the lobby layout and the public layout returns the new sections in order', async () => {
    const before = await adminLayout();
    const titles = [`first-${randomUUID()}`, `second-${randomUUID()}`, `third-${randomUUID()}`];

    const res = await replaceLayout(before.version, titles.map(note));

    expect(res.status).toBe(200);
    const saved = AdminLayoutSchema.parse(await bodyOf(res));
    expect(saved.version).toBe(before.version + 1);
    expect(saved.sections.map((section) => section.sortOrder)).toEqual([0, 1, 2]);
    expect(await publicTitles('/lobby/layout')).toEqual(titles);
    const reversed = [...saved.sections].reverse();
    const reorder = await replaceLayout(
      saved.version,
      reversed.map(({ id, type, config }) => ({ id, type, config })),
    );
    expect(reorder.status).toBe(200);
    expect(await publicTitles('/lobby/layout')).toEqual([...titles].reverse());
  });

  it('a layout keyed by name returns only that layout and an unknown key returns an empty layout', async () => {
    const key = `lay-${randomUUID().slice(0, 8)}`;
    const title = `keyed-${randomUUID()}`;
    await db()
      .insert(lobbySection)
      .values({ layoutKey: key, type: 'test-note', config: { title }, sortOrder: 0 });

    expect(await publicTitles(`/lobby/layout?layoutKey=${key}`)).toEqual([title]);
    expect(await publicTitles(`/lobby/layout?layoutKey=nope-${randomUUID().slice(0, 8)}`)).toEqual(
      [],
    );
    expect(await publicTitles('/lobby/layout')).not.toContain(title);
  });

  it('a section whose referenced category does not exist is refused', async () => {
    const before = await adminLayout();
    const existing = await newLobbyCategory();

    const refused = await replaceLayout(before.version, [
      { type: 'test-category', config: { categoryId: randomUUID() } },
    ]);

    expect(refused.status).toBe(400);
    expect(ErrorSchema.parse(await bodyOf(refused)).code).toBe('BAD_REQUEST');
    expect(await adminLayout()).toEqual(before);
    const accepted = await replaceLayout(before.version, [
      { type: 'test-category', config: { categoryId: existing.id } },
    ]);
    expect(accepted.status).toBe(200);
    expect(AdminLayoutSchema.parse(await bodyOf(accepted)).version).toBe(before.version + 1);
  });

  it('replacing the layout with duplicate section ids is refused', async () => {
    const before = await adminLayout();
    const id = randomUUID();

    const res = await replaceLayout(before.version, [
      { id, ...note('dup-a') },
      { id, ...note('dup-b') },
    ]);

    expect(res.status).toBe(400);
    expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('BAD_REQUEST');
    expect(await adminLayout()).toEqual(before);
  });

  it('a non-admin calling replace or admin get layout is refused as forbidden', async () => {
    const player = await newPlayer(e2e.app, 'lobby-nonadmin');
    const before = await adminLayout();

    const read = await player.client.get('/backoffice/lobby/layout');
    const write = await player.client.put('/backoffice/lobby/layout', {
      version: before.version,
      sections: [note('forbidden')],
    });

    for (const res of [read, write]) {
      expect(res.status).toBe(403);
      expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('FORBIDDEN');
    }
    expect(await adminLayout()).toEqual(before);
  });
});

describe('lobby catalog reads', () => {
  it('the public featured list contains only active games', async () => {
    const active = await newGame(e2e);
    const inactive = await newGame(e2e, { isActive: false });
    const slotOff = await newGame(e2e);
    await db()
      .insert(featuredSlot)
      .values([
        { gameId: active.gameId, title: 'Active', placement: 'hero' },
        { gameId: inactive.gameId, title: 'Inactive', placement: 'hero' },
        { gameId: slotOff.gameId, title: 'Slot off', placement: 'hero', isActive: false },
      ]);

    const res = await e2e.app.app.request('/lobby/featured');

    expect(res.status).toBe(200);
    const ids = FeaturedSchema.parse(await bodyOf(res)).map((slot) => slot.gameId);
    expect(ids).toContain(active.gameId);
    expect(ids).not.toContain(inactive.gameId);
    expect(ids).not.toContain(slotOff.gameId);
  });

  it('lobby search returns matching active games and ignores inactive ones', async () => {
    const token = `Zq${randomUUID().replaceAll('-', '')}`;
    const active = await newGame(e2e, { name: `${token} Active` });
    const inactive = await newGame(e2e, { name: `${token} Inactive`, isActive: false });
    const unrelated = await newGame(e2e, { name: `Other ${randomUUID()}` });

    const res = await e2e.app.app.request(`/lobby/search?q=${token.toLowerCase()}`);

    expect(res.status).toBe(200);
    const ids = GamesSchema.parse(await bodyOf(res)).map((found) => found.id);
    expect(ids).toEqual([active.gameId]);
    expect(ids).not.toContain(inactive.gameId);
    expect(ids).not.toContain(unrelated.gameId);
  });

  it.todo(
    'GAP: lobby search with an empty or over-long query is rejected by validation (casino/lobby/contract/index.ts:119 q is an unbounded string)',
  );

  it('a category fetched by an unknown slug returns not found', async () => {
    const res = await e2e.app.app.request(`/lobby/categories/unknown-${randomUUID()}`);

    expect(res.status).toBe(404);
    expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('NOT_FOUND');
  });
});

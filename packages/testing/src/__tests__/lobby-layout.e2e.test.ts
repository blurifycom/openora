import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '@openora/core/server';
import {
  asAdmin,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
  bootE2e,
  closeE2e,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function currentVersion(layoutKey?: string) {
  const query = layoutKey ? `?layoutKey=${layoutKey}` : '';
  const res = await admin.get(`/backoffice/lobby/layout${query}`);
  expect(res.status).toBe(200);
  return ((await json(res))['version'] as number) ?? 0;
}

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'test-lobby-sections',
        path: fileURLToPath(new URL('../test-lobby-sections-plugin.ts', import.meta.url)),
      },
    ],
  }));
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('lobby layout aggregate', () => {
  it('saves an ordered layout and serves resolved enabled sections publicly', async () => {
    const gameId = randomUUID();
    const save = await admin.put('/backoffice/lobby/layout', {
      version: await currentVersion(),
      sections: [
        {
          type: 'test-game',
          config: { title: 'Hot', gameId },
          isEnabled: true,
        },
        {
          type: 'test-game',
          config: { title: 'Hidden', gameId },
          isEnabled: false,
        },
      ],
    });
    expect(save.status).toBe(200);
    const saved = await json(save);
    expect(saved['version']).toBeGreaterThan(0);
    const sections = saved['sections'] as Array<{ id: string; sortOrder: number }>;
    expect(sections.map((section) => section.sortOrder)).toEqual([0, 1]);

    const { client } = await registerAndMaterializePlayer(app, {
      email: `lobby-player-${randomUUID()}@e2e.test`,
    });
    const publicRes = await client.get('/lobby/layout');
    expect(publicRes.status).toBe(200);
    const layout = (await publicRes.json()) as Array<{
      type: string;
      data?: { gameId: string; resolved: boolean };
    }>;
    expect(layout).toHaveLength(1);
    expect(layout[0]).toMatchObject({
      type: 'test-game',
      data: { gameId, resolved: true },
    });
  });

  it('rejects stale versions and leaves the layout unchanged', async () => {
    const beforeRes = await admin.get('/backoffice/lobby/layout');
    const before = await json(beforeRes);
    const conflict = await admin.put('/backoffice/lobby/layout', {
      version: (before['version'] as number) - 1,
      sections: [],
    });
    expect(conflict.status).toBe(409);
    const after = await json(await admin.get('/backoffice/lobby/layout'));
    expect(after).toEqual(before);
  });

  it('writes one audit record with before and after layout state', async () => {
    const save = await admin.put('/backoffice/lobby/layout', {
      version: await currentVersion(),
      sections: [
        {
          type: 'test-game',
          config: { title: 'Audited', gameId: randomUUID() },
          isEnabled: true,
        },
      ],
    });
    expect(save.status).toBe(200);

    await vi.waitFor(async () => {
      const auditRes = await admin.get('/audit/logs?action=lobby.layout.updated');
      expect(auditRes.status).toBe(200);
      const body = await json(auditRes);
      const entries = body['items'] as Array<{ before: unknown; after: unknown }>;
      expect(entries[0]).toMatchObject({
        before: expect.objectContaining({ version: expect.any(Number) }),
        after: expect.objectContaining({ version: expect.any(Number) }),
      });
    });
  });

  it('saves and serves a keyed layout without touching the default one', async () => {
    const layoutKey = `home-${randomUUID().slice(0, 8)}`;
    const globalBefore = await json(await admin.get('/backoffice/lobby/layout'));
    const gameId = randomUUID();

    const save = await admin.put('/backoffice/lobby/layout', {
      layoutKey,
      version: 0,
      sections: [{ type: 'test-game', config: { title: 'Home', gameId }, isEnabled: true }],
    });
    expect(save.status).toBe(200);
    const saved = await json(save);
    expect(saved['version']).toBe(1);

    expect(await json(await admin.get(`/backoffice/lobby/layout?layoutKey=${layoutKey}`))).toEqual(
      saved,
    );
    expect(await json(await admin.get('/backoffice/lobby/layout'))).toEqual(globalBefore);

    const { client } = await registerAndMaterializePlayer(app, {
      email: `lobby-keyed-${randomUUID()}@e2e.test`,
    });
    const keyed = await client.get(`/lobby/layout?layoutKey=${layoutKey}`);
    expect(keyed.status).toBe(200);
    expect(await keyed.json()).toMatchObject([
      { type: 'test-game', data: { gameId, resolved: true } },
    ]);

    const cleared = await admin.put('/backoffice/lobby/layout', {
      layoutKey,
      version: 1,
      sections: [],
    });
    expect(cleared.status).toBe(200);
    expect(await json(await admin.get('/backoffice/lobby/layout'))).toEqual(globalBefore);

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?action=lobby.layout.updated&resourceId=${layoutKey}`,
      );
      const entries = (await json(auditRes))['items'] as Array<{ resourceId: string }>;
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.resourceId === layoutKey)).toBe(true);
    });
  });

  it('rejects a section id from another layout and a malformed layout key', async () => {
    const layoutKey = `home-${randomUUID().slice(0, 8)}`;
    const globalSave = await admin.put('/backoffice/lobby/layout', {
      version: await currentVersion(),
      sections: [
        { type: 'test-game', config: { title: 'Casino', gameId: randomUUID() }, isEnabled: true },
      ],
    });
    expect(globalSave.status).toBe(200);
    const globalLayout = await json(globalSave);
    const [foreign] = globalLayout['sections'] as Array<{ id: string }>;
    if (!foreign) {
      throw new Error('global section was not created');
    }

    const steal = await admin.put('/backoffice/lobby/layout', {
      layoutKey,
      version: await currentVersion(layoutKey),
      sections: [
        {
          id: foreign.id,
          type: 'test-game',
          config: { title: 'Stolen', gameId: randomUUID() },
          isEnabled: true,
        },
      ],
    });
    expect(steal.status).toBe(404);
    expect(await json(await admin.get('/backoffice/lobby/layout'))).toEqual(globalLayout);

    expect((await admin.get('/backoffice/lobby/layout?layoutKey=Home%20Page')).status).toBe(400);
    expect((await admin.get('/lobby/layout?layoutKey=a_b')).status).toBe(400);
    expect(
      (
        await admin.put('/backoffice/lobby/layout', {
          layoutKey: 'x'.repeat(41),
          version: 0,
          sections: [],
        })
      ).status,
    ).toBe(400);
  });

  it('rejects player and anonymous access to both backoffice routes', async () => {
    const { client } = await registerAndMaterializePlayer(app, {
      email: `lobby-authz-${randomUUID()}@e2e.test`,
    });
    expect((await client.get('/backoffice/lobby/layout')).status).toBe(403);
    expect(
      (
        await client.put('/backoffice/lobby/layout', {
          version: 0,
          sections: [],
        })
      ).status,
    ).toBe(403);
    expect((await app.app.request('/backoffice/lobby/layout', { method: 'GET' })).status).toBe(401);
    expect(
      (
        await app.app.request('/backoffice/lobby/layout', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 0, sections: [] }),
        })
      ).status,
    ).toBe(401);
  });
});

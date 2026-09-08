import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '@openora/core/server';
import {
  asAdmin,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function currentVersion() {
  const res = await admin.get('/backoffice/lobby/layout');
  expect(res.status).toBe(200);
  return ((await json(res))['version'] as number) ?? 0;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';
  db = await setupTestDb();
  app = await bootTestApp({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'test-lobby-sections',
        path: fileURLToPath(new URL('../test-lobby-sections-plugin.ts', import.meta.url)),
      },
    ],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
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

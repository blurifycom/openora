import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '@openora/core/server';
import {
  asAdmin,
  type TestApp,
  type TestClient,
  type TestDb,
  bootE2e,
  closeE2e,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

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

describe('lobby layout keys with the platform switch off', () => {
  it('refuses to save a keyed layout and still saves the global one', async () => {
    const layoutKey = `home-${randomUUID().slice(0, 8)}`;
    const section = { type: 'test-game', config: { title: 'Home', gameId: randomUUID() } };

    const keyed = await admin.put('/backoffice/lobby/layout', {
      layoutKey,
      version: 0,
      sections: [{ ...section, isEnabled: true }],
    });
    expect(keyed.status).toBe(400);
    expect(
      await (await admin.get(`/backoffice/lobby/layout?layoutKey=${layoutKey}`)).json(),
    ).toEqual({ version: 0, sections: [] });

    const current = (await (await admin.get('/backoffice/lobby/layout')).json()) as {
      version: number;
    };
    const global = await admin.put('/backoffice/lobby/layout', {
      layoutKey: 'global',
      version: current.version,
      sections: [{ ...section, isEnabled: true }],
    });
    expect(global.status).toBe(200);
  });
});

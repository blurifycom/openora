import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let player: TestClient;
let admin: TestClient;

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  ({ client: player } = await registerAndMaterializePlayer(app, {
    email: `anti-phishing-code-${randomUUID()}@e2e.test`,
  }));
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('POST /identity/security/anti-phishing-code', () => {
  it('sets the code with no reauth and returns it raw via security.me on the next read', async () => {
    const res = await player.post('/identity/security/anti-phishing-code', {
      code: 'Sunny Meadow-42!',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { antiPhishingCode: string | null };
    expect(body.antiPhishingCode).toBe('Sunny Meadow-42!');

    const me = await player.get('/identity/security/me');
    expect((await me.json()) as { antiPhishingCode: string | null }).toMatchObject({
      antiPhishingCode: 'Sunny Meadow-42!',
    });
  });

  it('overwrites a previously set code (set/overwrite only, no remove route)', async () => {
    await player.post('/identity/security/anti-phishing-code', { code: 'First Code' });

    const res = await player.post('/identity/security/anti-phishing-code', {
      code: 'Second Code',
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { antiPhishingCode: string | null }).toMatchObject({
      antiPhishingCode: 'Second Code',
    });
  });

  it('rejects a code that is only whitespace, since it is empty after trimming', async () => {
    const res = await player.post('/identity/security/anti-phishing-code', { code: '   ' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('refuses the route for a non-player (admin) account', async () => {
    const res = await admin.post('/identity/security/anti-phishing-code', {
      code: 'Admin Attempt',
    });

    expect(res.status).toBe(403);
  });
});

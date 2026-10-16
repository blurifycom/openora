import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  registerAndMaterializePlayer,
  asAdmin,
  type TestDb,
  type TestApp,
  type TestClient,
  bootE2e,
  closeE2e,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let player: TestClient;
let admin: TestClient;

beforeAll(async () => {
  ({ db, app } = await bootE2e());
  ({ client: player } = await registerAndMaterializePlayer(app, {
    email: `anti-phishing-code-${randomUUID()}@e2e.test`,
  }));
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
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

  it('rejects a code longer than the email-safe 255-character limit', async () => {
    const res = await player.post('/identity/security/anti-phishing-code', {
      code: 'a'.repeat(256),
    });

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

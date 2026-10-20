import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  type TestDb,
  type TestApp,
} from '../index.js';

let db: TestDb;
let app: TestApp;

const ALLOWED_AVATAR = 'https://avatars.example.test/a.png';
const PRESET_AVATAR = 'https://play.example.test/avatars/gold-1.png';
const LOCAL_PRESET_AVATAR = 'http://localhost:3000/avatars/gold-1.png';

function newPlayer() {
  return registerAndMaterializePlayer(app, { email: `avatar-${randomUUID()}@e2e.test` });
}

async function storedImage(userId: string) {
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select({ image: user.image })
    .from(user)
    .where(eq(user.id, userId));
  return row?.image;
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
        id: 'testing-identity-avatar-config',
        path: fileURLToPath(
          new URL('./fixtures/test-identity-avatar-config-plugin.ts', import.meta.url),
        ),
      },
    ],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('PATCH /identity/profile - avatar host allowlist', () => {
  it('stores an https avatar on an allowed host', async () => {
    const { client, userId } = await newPlayer();

    const res = await client.patch('/identity/profile', { image: ALLOWED_AVATAR });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { image: ALLOWED_AVATAR } });
    expect(await storedImage(userId)).toBe(ALLOWED_AVATAR);
  });

  it('stores an avatar under an allowed URL prefix, http when the prefix is http', async () => {
    const { client, userId } = await newPlayer();

    for (const image of [PRESET_AVATAR, LOCAL_PRESET_AVATAR]) {
      const res = await client.patch('/identity/profile', { image });

      expect(res.status).toBe(200);
      expect(await storedImage(userId)).toBe(image);
    }
  });

  it('rejects a foreign host, plain http or a URL outside a prefix and keeps the stored avatar', async () => {
    const { client, userId } = await newPlayer();
    expect((await client.patch('/identity/profile', { image: ALLOWED_AVATAR })).status).toBe(200);

    for (const image of [
      'https://tracker.example/pixel.png',
      'http://avatars.example.test/a.png',
      'https://avatars.example.test:8443/a.png',
      'https://play.example.test/api/a.png',
      'https://cdn.play.example.test/avatars/gold-1.png',
      'https://play.example.test/avatars/../api/a.png',
      'https://play.example.test/avatars/%2e%2e/api/a.png',
      `${PRESET_AVATAR}?id=42`,
      `${PRESET_AVATAR}#x`,
      'https://u:p@play.example.test/avatars/gold-1.png',
      'http://localhost:3001/avatars/gold-1.png',
    ]) {
      const res = await client.patch('/identity/profile', { image });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: 'BAD_REQUEST',
        data: { reason: 'avatar_host_not_allowed' },
      });
    }
    expect(await storedImage(userId)).toBe(ALLOWED_AVATAR);
  });

  it('clears the avatar with image: null', async () => {
    const { client, userId } = await newPlayer();
    expect((await client.patch('/identity/profile', { image: ALLOWED_AVATAR })).status).toBe(200);

    const res = await client.patch('/identity/profile', { image: null });

    expect(res.status).toBe(200);
    expect(await storedImage(userId)).toBeNull();
  });
});

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

  it('rejects a foreign host or plain http and keeps the stored avatar', async () => {
    const { client, userId } = await newPlayer();
    expect((await client.patch('/identity/profile', { image: ALLOWED_AVATAR })).status).toBe(200);

    for (const image of [
      'https://tracker.example/pixel.png',
      'http://avatars.example.test/a.png',
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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import { PLAYER_BIO_MAX_LENGTH } from '@openora/core/contracts';
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
let admin: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

const uniqueHandle = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

async function newPlayer(label: string, username = uniqueHandle('p')) {
  const email = `profile-username-bio-${label}-${randomUUID()}@e2e.test`;
  return registerAndMaterializePlayer(app, { email, username });
}

async function profileAudits(playerId: string) {
  const res = await admin.get(`/audit/logs?resourceId=${playerId}&action=player.profile.updated`);
  expect(res.status).toBe(200);
  return (await readJson(res)).items;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('PATCH /profile - username', () => {
  it('changes the handle, lowercased, on both the profile and identity reads, and audits it', async () => {
    const { client, playerId } = await newPlayer('rename');
    const before = await readJson(await client.get('/profile'));
    const handle = uniqueHandle('New');

    const res = await client.patch('/profile', { username: handle });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ username: handle.toLowerCase() });
    expect(await readJson(await client.get('/profile'))).toMatchObject({
      username: handle.toLowerCase(),
    });
    expect(await readJson(await client.get('/identity/me'))).toMatchObject({
      username: handle.toLowerCase(),
    });
    const items = await profileAudits(playerId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      actorType: 'player',
      before: { username: before.username },
      after: { username: handle.toLowerCase() },
    });
  });

  it('treats resending the current handle as a no-op with no audit row', async () => {
    const { client, playerId } = await newPlayer('same');
    const { username } = await readJson(await client.get('/profile'));

    const res = await client.patch('/profile', { username });

    expect(res.status).toBe(200);
    expect(await profileAudits(playerId)).toHaveLength(0);
  });

  it('refuses a handle another player holds, case-insensitively, and writes nothing', async () => {
    const owner = await newPlayer('owner');
    const { username: taken } = await readJson(await owner.client.get('/profile'));
    const { client, playerId } = await newPlayer('squatter');
    const before = await readJson(await client.get('/profile'));

    const res = await client.patch('/profile', { username: taken.toUpperCase(), bio: 'hello' });

    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ code: 'CONFLICT' });
    expect(await readJson(await client.get('/profile'))).toMatchObject({
      username: before.username,
      bio: null,
    });
    expect(await readJson(await owner.client.get('/profile'))).toMatchObject({ username: taken });
    expect(await profileAudits(playerId)).toHaveLength(0);
  });

  it.each([['ab'], ['has space'], ['dash-name'], ['a'.repeat(21)]])(
    'rejects the malformed handle %j with a validation error',
    async (username) => {
      const { client } = await newPlayer('malformed');
      const before = await readJson(await client.get('/profile'));

      const res = await client.patch('/profile', { username });

      expect(res.status).toBe(400);
      expect(await readJson(await client.get('/profile'))).toMatchObject({
        username: before.username,
      });
    },
  );

  it('limits a player to five renames an hour without throttling other profile writes', async () => {
    const { client } = await newPlayer('rate');
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await client.patch('/profile', { username: uniqueHandle('r') })).status).toBe(200);
    }
    const { username: fifth } = await readJson(await client.get('/profile'));

    const res = await client.patch('/profile', { username: uniqueHandle('r') });

    expect(res.status).toBe(429);
    expect(await readJson(res)).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(await readJson(await client.get('/profile'))).toMatchObject({ username: fifth });
    expect((await client.patch('/profile', { username: fifth })).status).toBe(200);
    expect(
      (await client.patch('/profile', { allowFriendRequests: false, bio: 'Still here' })).status,
    ).toBe(200);
  });

  it('settles renames from more players than the pool has connections', async () => {
    const players = await Promise.all(
      Array.from({ length: 15 }, (_, index) => newPlayer(`burst-${index}`)),
    );

    const statuses = await Promise.all(
      players.map(async ({ client }) => {
        const res = await client.patch('/profile', { username: uniqueHandle('b') });
        return res.status;
      }),
    );

    expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);
    expect((await players[0]!.client.get('/profile')).status).toBe(200);
  }, 60_000);

  it('refuses a profane handle and writes nothing', async () => {
    const { client, playerId } = await newPlayer('profane-handle');
    const before = await readJson(await client.get('/profile'));

    const res = await client.patch('/profile', { username: uniqueHandle('big_ass') });

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      code: 'BAD_REQUEST',
      data: { reason: 'prohibited_language', field: 'username' },
    });
    expect(await readJson(await client.get('/profile'))).toMatchObject({
      username: before.username,
    });
    expect(await profileAudits(playerId)).toHaveLength(0);
  });

  it('lets a player whose stored handle trips the filter resend it with other changes', async () => {
    const { client } = await newPlayer('legacy-handle', uniqueHandle('big_ass'));
    const { username } = await readJson(await client.get('/profile'));

    const res = await client.patch('/profile', { username, bio: 'Hello' });

    expect(res.status).toBe(200);
    expect(await readJson(await client.get('/profile'))).toMatchObject({ bio: 'Hello' });
  });

  it('rejects an unauthenticated write', async () => {
    const res = await app.app.request('/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: uniqueHandle('anon') }),
    });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /profile - bio', () => {
  it('stores a trimmed bio and reads it back', async () => {
    const { client } = await newPlayer('bio');

    const res = await client.patch('/profile', { bio: '  Slots and poker.  ' });

    expect(res.status).toBe(200);
    expect(await readJson(await client.get('/profile'))).toMatchObject({
      bio: 'Slots and poker.',
    });
  });

  it.each([[''], ['   '], [null]])('clears the bio when sent %j', async (bio) => {
    const { client } = await newPlayer('bio-clear');
    await client.patch('/profile', { bio: 'Something' });

    const res = await client.patch('/profile', { bio });

    expect(res.status).toBe(200);
    expect(await readJson(await client.get('/profile'))).toMatchObject({ bio: null });
  });

  it('writes no audit row when a blank bio clears a bio that is already empty', async () => {
    const { client, playerId } = await newPlayer('bio-noop');
    const before = await readJson(await client.get('/profile'));

    const res = await client.patch('/profile', { bio: '   ' });

    expect(res.status).toBe(200);
    expect(await readJson(await client.get('/profile'))).toMatchObject({
      bio: null,
      updatedAt: before.updatedAt,
    });
    expect(await profileAudits(playerId)).toHaveLength(0);
  });

  it('audits only the fields whose value changed when a PATCH resends stored ones', async () => {
    const { client, playerId } = await newPlayer('partial');
    expect((await client.patch('/profile', { firstName: 'Ada', bio: 'Same' })).status).toBe(200);

    const res = await client.patch('/profile', {
      firstName: 'Ada',
      bio: 'Same',
      lastName: 'Lovelace',
    });

    expect(res.status).toBe(200);
    const items = await profileAudits(playerId);
    expect(items).toHaveLength(2);
    const latest = items.find(
      (item: { after: Record<string, unknown> }) => 'lastName' in item.after,
    );
    expect(latest.before).toEqual({ lastName: null });
    expect(latest.after).toEqual({ lastName: 'Lovelace' });
  });

  it('rejects bidi overrides and zero-width characters but keeps joined emoji', async () => {
    const { client } = await newPlayer('bio-chars');

    expect((await client.patch('/profile', { bio: 'safe \u202Eevil' })).status).toBe(400);
    expect((await client.patch('/profile', { bio: 'zero\u200Bwidth' })).status).toBe(400);
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect((await client.patch('/profile', { bio: `Team ${family}` })).status).toBe(200);
    expect(await readJson(await client.get('/profile'))).toMatchObject({ bio: `Team ${family}` });
  });

  it('refuses a profane bio and keeps the stored one', async () => {
    const { client, playerId } = await newPlayer('bio-profane');
    expect((await client.patch('/profile', { bio: 'Clean' })).status).toBe(200);

    const res = await client.patch('/profile', { bio: 'you are a fuck', firstName: 'Ada' });

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      code: 'BAD_REQUEST',
      data: { reason: 'prohibited_language', field: 'bio' },
    });
    expect(await readJson(await client.get('/profile'))).toMatchObject({
      bio: 'Clean',
      firstName: null,
    });
    expect(await profileAudits(playerId)).toHaveLength(1);
  });

  it('defangs script and data links but keeps ordinary ones', async () => {
    const { client } = await newPlayer('bio-links');

    const res = await client.patch('/profile', {
      bio: 'javascript:alert(1) data:text/html,x https://example.com',
    });

    expect(res.status).toBe(200);
    expect(await readJson(await client.get('/profile'))).toMatchObject({
      bio: 'javascript alert(1) data text/html,x https://example.com',
    });
  });

  it('accepts exactly the limit and rejects one character over it', async () => {
    const { client } = await newPlayer('bio-limit');

    const atLimit = 'x'.repeat(PLAYER_BIO_MAX_LENGTH);
    expect((await client.patch('/profile', { bio: atLimit })).status).toBe(200);

    const res = await client.patch('/profile', { bio: 'y'.repeat(PLAYER_BIO_MAX_LENGTH + 1) });

    expect(res.status).toBe(400);
    expect(await readJson(await client.get('/profile'))).toMatchObject({ bio: atLimit });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import {
  setupTestDb,
  bootTestApp,
  asAdmin,
  seedMinimal,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

type UserList = { items: { email: string; role: string }[]; total: number };

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let player: TestClient;
let playerEmail: string;

async function listUsers(query: string): Promise<UserList> {
  const res = await admin.get(`/backoffice/users?limit=100&${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as UserList;
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

  playerEmail = `staff-only-${randomUUID()}@example.test`;
  ({ client: player } = await registerAndMaterializePlayer(app, { email: playerEmail }));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('GET /backoffice/users staffOnly', () => {
  it('lists players and staff together by default', async () => {
    const { items } = await listUsers(`search=${playerEmail}`);

    expect(items.map((u) => u.email)).toEqual([playerEmail]);
  });

  it('leaves players out of the rows and the total', async () => {
    const { items, total } = await listUsers('staffOnly=true');

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((u) => u.role !== 'player')).toBe(true);
    expect(total).toBe(items.length);
  });

  it('does not surface a player through search', async () => {
    const { items, total } = await listUsers(`staffOnly=true&search=${playerEmail}`);

    expect(items).toEqual([]);
    expect(total).toBe(0);
  });

  it('refuses a player reaching for it', async () => {
    const res = await player.get('/backoffice/users?staffOnly=true');

    expect(res.status).toBe(403);
  });
});

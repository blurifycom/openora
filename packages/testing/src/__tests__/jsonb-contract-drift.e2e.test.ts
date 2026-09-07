import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { seedChatCommands } from '@openora/core/engagement/seed/chat-commands';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
} from '../index.js';

let db: TestDb;
let app: TestApp;

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  await seedChatCommands(app.container.get(DRIZZLE).db);
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

// A stored jsonb value outlives the contract that wrote it. Every route below selects a
// column holding one, and each must serve the rest of its rows rather than fail wholesale.
describe('a jsonb value the current contract cannot read', () => {
  it('costs a command its config, not the whole command list', async () => {
    const drizzle = app.container.get(DRIZZLE);
    await drizzle.db.execute(
      sql`UPDATE "chat_command_config" SET "config" = '{"minAmount":"1.00000000"}'::jsonb WHERE "key" = 'gift'`,
    );

    const res = await app.app.request('/chat-command/commands');

    expect(res.status).toBe(200);
    const commands = (await res.json()) as { key: string; config: unknown }[];
    expect(commands.find((c) => c.key === 'gift')?.config).toBeNull();
  });

  it('costs a system message its place, not the whole room history', async () => {
    const player = await registerAndMaterializePlayer(app, {
      email: `drift_${randomUUID().slice(0, 8)}@e2e.test`,
      username: `drift_${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    });
    const drizzle = app.container.get(DRIZZLE);
    // `command: 'tip'` is no command this build knows - the shape a removed or renamed
    // command leaves behind in messages already sent.
    await drizzle.db.execute(sql`
      INSERT INTO "chat_message" ("room_id", "user_id", "username", "content", "type", "metadata")
      VALUES (NULL, ${player.userId}::uuid, 'system', 'tipped', 'system',
              '{"command":"tip","amount":"1.00"}'::jsonb)
    `);

    const res = await player.client.get('/chat/global');

    expect(res.status).toBe(200);
    const messages = (await res.json()) as { content: string; metadata: unknown }[];
    // A system message is its command metadata, so an unreadable one cannot be rendered
    // at all. It drops out; the rest of the history is still served.
    expect(messages.find((m) => m.content === 'tipped')).toBeUndefined();
    expect(messages.length).toBeGreaterThan(1);
  });
});

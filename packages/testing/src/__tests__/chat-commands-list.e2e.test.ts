import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { seedChatCommands } from '@openora/core/engagement/seed/chat-commands';
import { ChatCommandDescriptorSchema } from '@openora/core/engagement/contracts/chat-commands';
import { setupTestDb, bootTestApp, seedMinimal, type TestDb, type TestApp } from '../index.js';

let db: TestDb;
let app: TestApp;

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const basePlugins = await loadExtensions();
  app = await bootTestApp({ plugins: basePlugins, databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  await seedChatCommands(app.container.get(DRIZZLE).db);
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('listCommands', () => {
  it('returns the seeded commands', async () => {
    const res = await app.app.request('/chat-command/commands');

    expect(res.status).toBe(200);
    const commands = ChatCommandDescriptorSchema.array().parse(await res.json());
    expect(commands.map((c) => c.key)).toContain('gift');
  });

  // A row whose jsonb config predates a contract change must cost that row its limit, not
  // 500 the list for every player in chat.
  it('survives a row whose config no longer matches the contract', async () => {
    const drizzle = app.container.get(DRIZZLE);
    await drizzle.db.execute(
      sql`UPDATE "chat_command_config" SET "config" = '{"minAmount":"1.00000000"}'::jsonb WHERE "key" = 'gift'`,
    );

    const res = await app.app.request('/chat-command/commands');

    expect(res.status).toBe(200);
    const commands = ChatCommandDescriptorSchema.array().parse(await res.json());
    expect(commands.find((c) => c.key === 'gift')?.config).toBeNull();
  });
});

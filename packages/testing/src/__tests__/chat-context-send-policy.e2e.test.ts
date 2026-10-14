import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { loadExtensions } from '@openora/core/server';
import { CHAT_CONTEXT_ROOMS, ChatContextSendDeniedDataSchema } from '@openora/core/contracts';
import { ChatMessageSchema } from '@openora/core/engagement/contracts/chat';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  type TestDb,
  type TestApp,
  uniqueUsername,
} from '../index.js';
import { DENIED_CONTEXT_REF_PREFIX } from './fixtures/test-chat-context-send-policy-plugin.js';

const SendRefusalSchema = z.object({ code: z.string(), data: ChatContextSendDeniedDataSchema });

let db: TestDb;
let app: TestApp;

async function registerChatter(prefix: string) {
  const username = uniqueUsername(prefix);
  return registerAndMaterializePlayer(app, { email: `${username}@e2e.test`, username });
}

async function contextRoom(ref: string, memberId: string) {
  const { room } = await app.container
    .get(CHAT_CONTEXT_ROOMS)
    .ensureRoom({ ref, name: 'Context', memberIds: [memberId] });
  return room;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const fixture = fileURLToPath(
    new URL('./fixtures/test-chat-context-send-policy-plugin.ts', import.meta.url),
  );
  app = await bootTestApp({
    plugins: [...(await loadExtensions()), { id: 'test-chat-context-send-policy', path: fixture }],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('chat: context room send policy', () => {
  it('posts a message the bound policy allows', async () => {
    const member = await registerChatter('allowed');
    const room = await contextRoom(`ctx:${randomUUID()}`, member.userId);

    const sent = await member.client.post(`/chat/rooms/${room.id}/messages`, { content: 'gl' });

    expect(sent.status).toBe(200);
    expect(ChatMessageSchema.parse(await sent.json()).content).toBe('gl');
  });

  it('refuses a message the bound policy denies, with its reason, and stores nothing', async () => {
    const member = await registerChatter('denied');
    const room = await contextRoom(`${DENIED_CONTEXT_REF_PREFIX}${randomUUID()}`, member.userId);

    const refused = await member.client.post(`/chat/rooms/${room.id}/messages`, { content: 'hi' });
    const history = await member.client.get(`/chat/rooms/${room.id}/messages`);

    expect(refused.status).toBe(403);
    expect(SendRefusalSchema.parse(await refused.json())).toEqual({
      code: 'FORBIDDEN',
      data: { reason: 'context_send_denied', policyReason: 'recipient_privacy' },
    });
    expect(ChatMessageSchema.array().parse(await history.json())).toEqual([]);
  });
});

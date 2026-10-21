import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { CHAT_CONTEXT_ROOMS, ChatContextSendDeniedDataSchema } from '@openora/core/contracts';
import { ChatMessageSchema } from '@openora/core/engagement/contracts/chat';
import { type TestDb, type TestApp, bootE2e, closeE2e, registerChatter } from '../index.js';
import { DENIED_CONTEXT_REF_PREFIX } from './fixtures/test-chat-context-send-policy-plugin.js';

const SendRefusalSchema = z.object({ code: z.string(), data: ChatContextSendDeniedDataSchema });

let db: TestDb;
let app: TestApp;

async function contextRoom(ref: string, memberId: string) {
  const { room } = await app.container
    .get(CHAT_CONTEXT_ROOMS)
    .ensureRoom({ ref, name: 'Context', memberIds: [memberId] });
  return room;
}

beforeAll(async () => {
  const fixture = fileURLToPath(
    new URL('./fixtures/test-chat-context-send-policy-plugin.ts', import.meta.url),
  );
  ({ db, app } = await bootE2e({
    plugins: [...(await loadExtensions()), { id: 'test-chat-context-send-policy', path: fixture }],
  }));
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('chat: context room send policy', () => {
  it('posts a message the bound policy allows', async () => {
    const member = await registerChatter(app, 'allowed');
    const room = await contextRoom(`ctx:${randomUUID()}`, member.userId);

    const sent = await member.client.post(`/chat/rooms/${room.id}/messages`, { content: 'gl' });

    expect(sent.status).toBe(200);
    expect(ChatMessageSchema.parse(await sent.json()).content).toBe('gl');
  });

  it('refuses a message the bound policy denies, with its reason, and stores nothing', async () => {
    const member = await registerChatter(app, 'denied');
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

  it('audits a denied send as a refused access', async () => {
    const member = await registerChatter(app, 'audited');
    const room = await contextRoom(`${DENIED_CONTEXT_REF_PREFIX}${randomUUID()}`, member.userId);

    const refused = await member.client.post(`/chat/rooms/${room.id}/messages`, { content: 'hi' });

    expect(refused.status).toBe(403);
    await vi.waitFor(
      async () => {
        const rows = await app.container
          .get(DRIZZLE)
          .db.select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'identity.user.unauthorized_access'),
              eq(auditLog.actorId, member.playerId),
            ),
          );
        expect(rows).toEqual([
          expect.objectContaining({
            actorType: 'player',
            resourceType: 'chat.message',
            resourceId: 'chat.message:send',
            result: 'failure',
          }),
        ]);
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});

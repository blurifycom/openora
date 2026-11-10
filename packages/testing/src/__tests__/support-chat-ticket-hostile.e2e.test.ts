import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { AUDIT_WRITER, SUPPORT_CHAT_PROVIDER } from '@openora/core/contracts';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import { readSupportChatCalls } from '../test-support-chat-plugin.js';

const supportChatPluginPath = fileURLToPath(
  new URL('../test-support-chat-plugin.ts', import.meta.url),
);
const TICKETS = '/support-chat/tickets';

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;

type Player = { client: TestClient; userId: string; playerId: string; email: string };

async function newPlayer(): Promise<Player> {
  const email = `ticket-hostile-${randomUUID()}@e2e.test`;
  return { ...(await registerAndMaterializePlayer(testApp, { email })), email };
}

const ticketsTo = (email: string) =>
  readSupportChatCalls().tickets.filter((ticket) => ticket.requester.email === email);

const ticketAudits = (playerId: string) =>
  testApp.container
    .get(DRIZZLE)
    .db.select()
    .from(auditLog)
    .where(
      and(eq(auditLog.action, 'support_chat.ticket.created'), eq(auditLog.resourceId, playerId)),
    );

beforeAll(async () => {
  const extensions = await loadExtensions();
  ({ db, app: testApp } = await bootE2e({
    plugins: [...extensions, { id: 'testing-support-chat', path: supportChatPluginPath }],
  }));
  admin = await asAdmin(testApp.app);
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeE2e({ app: testApp, db });
});

describe('offline ticket under hostile input and state', () => {
  it('files the account language, which is "en" for a player who never chose one', async () => {
    const p = await newPlayer();

    expect((await p.client.post(TICKETS, { message: 'hello' })).status).toBe(200);

    expect(ticketsTo(p.email)).toEqual([
      { requester: { name: expect.any(String), email: p.email }, language: 'en', message: 'hello' },
    ]);
  });

  it('hands the vendor html, control characters and line breaks untouched, trimming the ends only', async () => {
    const p = await newPlayer();
    const message = '<script>alert(1)</script>\r\nline two\u0000 ‮';

    expect((await p.client.post(TICKETS, { message: `\n\t ${message}  ` })).status).toBe(200);

    expect(ticketsTo(p.email)[0]?.message).toBe(message.trim());
  });

  it('counts the limit in characters: 5000 emoji pass intact, 5001 are refused', async () => {
    const p = await newPlayer();
    const atLimit = '\u{1F600}'.repeat(5000);

    expect((await p.client.post(TICKETS, { message: '\u{1F600}'.repeat(5001) })).status).toBe(400);
    expect((await p.client.post(TICKETS, { message: atLimit })).status).toBe(200);

    expect(ticketsTo(p.email).map((t) => t.message)).toEqual([atLimit]);
  });

  it('keys the rate limit on the account, so a changing forwarded address does not reset it', async () => {
    const p = await newPlayer();
    const post = (ip: string) =>
      p.client.request(TICKETS, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-real-ip': ip },
        body: JSON.stringify({ message: 'again' }),
      });

    for (let call = 0; call < 5; call++) {
      expect((await post(`10.0.0.${call}`)).status).toBe(200);
    }

    expect((await post('203.0.113.77')).status).toBe(429);
    expect(ticketsTo(p.email)).toHaveLength(5);
  });

  it("never carries one player's name or email on another player's ticket under parallel posts", async () => {
    const players = await Promise.all([newPlayer(), newPlayer(), newPlayer(), newPlayer()]);

    const answers = await Promise.all(
      players.map((p, i) => p.client.post(TICKETS, { message: `from ${i} ${p.email}` })),
    );

    expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    const names = new Map(
      (
        await testApp.container
          .get(DRIZZLE)
          .db.select({ id: user.id, username: user.username })
          .from(user)
      ).map((row) => [row.id, row.username]),
    );
    for (const [i, p] of players.entries()) {
      expect(ticketsTo(p.email)).toEqual([
        {
          requester: { name: names.get(p.userId), email: p.email },
          language: 'en',
          message: `from ${i} ${p.email}`,
        },
      ]);
    }
  });

  it('answers 200 and keeps the ticket when the audit write fails after it', async () => {
    const p = await newPlayer();
    const audit = testApp.container.get(AUDIT_WRITER);
    const record = audit.record.bind(audit);
    vi.spyOn(audit, 'record').mockImplementation(async (entry) => {
      if (entry.action === 'support_chat.ticket.created') {
        throw new Error(`audit store down for ${p.email}`);
      }
      return record(entry);
    });

    const res = await p.client.post(TICKETS, { message: 'hello' });

    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(p.email);
    expect(ticketsTo(p.email)).toHaveLength(1);
    expect(await ticketAudits(p.playerId)).toHaveLength(0);
  });

  it('answers 503 not configured for a provider without createTicket while its session route still works', async () => {
    const p = await newPlayer();
    const provider = testApp.container.get(SUPPORT_CHAT_PROVIDER);
    const createTicket = provider.createTicket;
    delete provider.createTicket;
    try {
      const res = await p.client.post(TICKETS, { message: 'hello' });

      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ message: 'Support chat is not configured' });
      expect((await p.client.post('/support-chat/session')).status).toBe(200);
      expect(ticketsTo(p.email)).toHaveLength(0);
      expect(await ticketAudits(p.playerId)).toHaveLength(0);
    } finally {
      if (createTicket) {
        provider.createTicket = createTicket;
      }
    }
  });

  it('files nothing for a player an admin suspended, whose sessions are revoked', async () => {
    const p = await newPlayer();
    const suspended = await admin.patch(`/players/${p.playerId}`, { status: 'suspended' });
    expect(suspended.status, await suspended.clone().text()).toBe(200);

    const res = await p.client.post(TICKETS, { message: 'let me back in' });

    expect(res.status).toBe(401);
    expect(ticketsTo(p.email)).toHaveLength(0);
  });
});

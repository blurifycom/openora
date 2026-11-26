import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadExtensions } from '@openora/core/server';
import { SupportChatCustomerTokenSchema, SupportHistorySchema } from '@openora/core/contracts';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  flushAudit,
  forceEmailVerified,
  newPlayer,
  waitForEmail,
  type E2e,
  type TestClient,
} from '../index.js';
import {
  failNextSupportChatToken,
  failNextSupportTicket,
  readSupportChatCalls,
  resetSupportChat,
} from '../test-support-chat-plugin.js';
import {
  answerSupportHistoryWith,
  readSupportHistoryCalls,
  resetSupportHistory,
} from '../test-support-history-plugin.js';
import { ErrorBodySchema, PASSWORD, uniqueEmail } from './support/identity.js';

const pluginPath = (file: string) => fileURLToPath(new URL(file, import.meta.url));

const chatPlugin = {
  id: 'testing-support-chat',
  path: pluginPath('../test-support-chat-plugin.ts'),
};
const historyPlugin = {
  id: 'testing-support-history',
  path: pluginPath('../test-support-history-plugin.ts'),
};

type Member = Awaited<ReturnType<typeof newPlayer>>;

const verifiedPlayer = async (e2e: E2e, prefix: string) => {
  const member = await newPlayer(e2e.app, prefix);
  await forceEmailVerified(e2e.app, member.userId);
  return member;
};

const openSession = async (member: Member) => {
  const res = await member.client.post('/support-chat/session');
  expect(res.status).toBe(200);
  return SupportChatCustomerTokenSchema.parse(await res.json());
};

const syncsFor = (customerId: string) =>
  readSupportChatCalls().syncs.filter((sync) => sync.customerId === customerId);

const changeEmail = async (member: Member, newEmail: string) => {
  const requested = await member.client.post('/identity/email/change/request', {
    newEmail,
    currentPassword: PASSWORD,
  });
  expect(requested.status).toBe(200);
  const mail = await waitForEmail(newEmail, () => true);
  const otp = /\b(\d{6})\b/.exec(mail.text)?.[1];
  if (!otp) {
    throw new Error('no change code in mail');
  }
  const confirmed = await member.client.post('/identity/email/change/confirm', { newEmail, otp });
  expect(confirmed.status).toBe(200);
};

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootE2e({ plugins: [...(await loadExtensions()), chatPlugin] });
}, 60_000);

afterAll(() => closeE2e(e2e));

describe('support chat session and tickets', () => {
  it('a signed in player opens a support session and gets a customer token', async () => {
    resetSupportChat();
    const member = await verifiedPlayer(e2e, 'sc-session');

    const first = await openSession(member);
    const second = await openSession(member);

    expect(first.tokenType).toBe('Bearer');
    expect(second.customerId).toBe(first.customerId);
    expect(second.accessToken).not.toBe(first.accessToken);
    const requests = readSupportChatCalls().tokenRequests;
    expect(requests).toContainEqual({});
    expect(requests).toContainEqual({ customerId: first.customerId });
  });

  it('opening a session syncs the customer context and a later profile change is synced until the chat is settled', async () => {
    resetSupportChat();
    const member = await verifiedPlayer(e2e, 'sc-sync');

    const { customerId } = await openSession(member);

    await vi.waitFor(() => expect(syncsFor(customerId).length).toBeGreaterThan(0), {
      timeout: 15_000,
    });
    expect(syncsFor(customerId).at(-1)?.context).toEqual(
      expect.objectContaining({
        userId: member.userId,
        playerId: member.playerId,
        email: member.email,
      }),
    );

    const newEmail = uniqueEmail('sc-sync-new');
    await changeEmail(member, newEmail);

    await vi.waitFor(() => expect(syncsFor(customerId).at(-1)?.context.email).toBe(newEmail), {
      timeout: 15_000,
    });
  });

  it('a player creates a ticket and the provider receives the customer context', async () => {
    resetSupportChat();
    const member = await verifiedPlayer(e2e, 'sc-ticket');
    const { customerId } = await openSession(member);

    const res = await member.client.post('/support-chat/tickets', {
      subject: 'Cannot see my deposit',
      message: 'The deposit made today is missing',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(readSupportChatCalls().tickets).toEqual([
      expect.objectContaining({
        subject: 'Cannot see my deposit',
        message: 'The deposit made today is missing',
        requester: expect.objectContaining({ email: member.email }),
      }),
    ]);
    await vi.waitFor(() => expect(syncsFor(customerId)).not.toEqual([]), { timeout: 15_000 });
    expect(syncsFor(customerId)[0]?.context).toEqual(
      expect.objectContaining({ userId: member.userId }),
    );
  });

  it('an unauthenticated caller cannot open a session or create a ticket', async () => {
    resetSupportChat();

    const session = await e2e.app.app.request('/support-chat/session', { method: 'POST' });
    const ticket = await e2e.app.app.request('/support-chat/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'anon', message: 'anon' }),
    });

    expect([session.status, ticket.status]).toEqual([401, 401]);
    expect(readSupportChatCalls().tokenRequests).toEqual([]);
    expect(readSupportChatCalls().tickets).toEqual([]);
  });

  it('a provider failure returns a generic refusal and no adapter data reaches the player', async () => {
    resetSupportChat();
    const member = await verifiedPlayer(e2e, 'sc-fail');
    const secret = 'vendor-secret-8f3a';
    failNextSupportChatToken(new Error(secret));

    const session = await member.client.post('/support-chat/session');
    failNextSupportTicket(new Error(secret));
    const ticket = await member.client.post('/support-chat/tickets', {
      subject: 'Help',
      message: 'Please help',
    });

    expect([session.status, ticket.status]).toEqual([503, 503]);
    const sessionText = await session.text();
    const ticketText = await ticket.text();
    expect(sessionText).not.toContain(secret);
    expect(ticketText).not.toContain(secret);
    expect(ErrorBodySchema.parse(JSON.parse(sessionText)).code).toBe(
      ErrorBodySchema.parse(JSON.parse(ticketText)).code,
    );
    expect(readSupportChatCalls().tickets).toEqual([]);
  });

  it.todo(
    'GAP: a ticket created twice with the same key does not create a duplicate at the provider (createTicket has no idempotency key and is documented as not idempotent)',
  );
});

describe('support history by email', () => {
  const HistoryItemsSchema = SupportHistorySchema;

  const historyAs = (client: TestClient, userId: string) =>
    client.get(`/support-chat/admin/players/${userId}/history`);

  it('history is not configured returns the not configured refusal', async () => {
    const member = await verifiedPlayer(e2e, 'sh-none');
    const admin = await asAdmin(e2e.app.app);

    const res = await historyAs(admin, member.userId);

    expect(res.status).toBe(503);
    expect(ErrorBodySchema.parse(await res.json()).code).toBe('SERVICE_UNAVAILABLE');
  });

  describe('with a history reader', () => {
    let history: E2e;

    beforeAll(async () => {
      history = await bootE2e({
        plugins: [...(await loadExtensions()), chatPlugin, historyPlugin],
      });
    }, 60_000);

    afterAll(() => closeE2e(history));

    const ticketItem = (id: string) => ({
      kind: 'ticket' as const,
      id,
      reference: `#${id}`,
      subject: `Subject ${id}`,
      status: 'open' as const,
      assignee: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      url: `https://agent.example.test/ticket/${id}`,
    });

    it('a player lists support history including items filed under a previous email within its window', async () => {
      resetSupportHistory();
      const member = await verifiedPlayer(history, 'sh-prev');
      const previousEmail = member.email;
      const newEmail = uniqueEmail('sh-prev-new');
      await changeEmail(member, newEmail);
      await flushAudit(history.app);
      answerSupportHistoryWith({ tickets: [ticketItem('prev-1')] });
      const admin = await asAdmin(history.app.app);

      const res = await historyAs(admin, member.userId);

      expect(res.status).toBe(200);
      const view = HistoryItemsSchema.parse(await res.json());
      expect(view.tickets.state).toBe('ok');
      expect(view.tickets.items.map((item) => item.id)).toEqual(['prev-1']);
      const asked = readSupportHistoryCalls().listTickets;
      expect(asked).toHaveLength(1);
      expect(asked[0]?.windows.map((window) => window.email)).toEqual([previousEmail, newEmail]);
      expect(asked[0]?.windows[0]?.to).not.toBeNull();
      expect(asked[0]?.windows[1]?.to).toBeNull();
    });

    it('the vendor is asked only for the emails the player held, so an item filed under another email is never requested', async () => {
      resetSupportHistory();
      const member = await verifiedPlayer(history, 'sh-held');
      const stranger = await verifiedPlayer(history, 'sh-held-other');
      await flushAudit(history.app);
      const admin = await asAdmin(history.app.app);

      const res = await historyAs(admin, member.userId);

      expect(res.status).toBe(200);
      const asked = readSupportHistoryCalls().listTickets;
      const emails = asked.flatMap((call) => call.windows.map((window) => window.email));
      expect(emails).toEqual([member.email]);
      expect(emails).not.toContain(stranger.email);
    });

    it('a player cannot read another player support history', async () => {
      resetSupportHistory();
      const owner = await verifiedPlayer(history, 'sh-owner');
      const intruder = await verifiedPlayer(history, 'sh-intruder');

      const res = await historyAs(intruder.client, owner.userId);

      expect(res.status).toBe(403);
      expect(readSupportHistoryCalls()).toEqual({ listTickets: [], listChats: [] });
    });
  });
});

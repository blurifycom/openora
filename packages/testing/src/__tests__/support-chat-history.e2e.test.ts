import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { and, asc, eq, ne } from 'drizzle-orm';
import {
  RATE_LIMITER,
  RATE_LIMIT_KEYS,
  SupportHistorySchema,
  makeRateLimitKey,
  type SupportHistoryItem,
} from '@openora/core/contracts';
import { DRIZZLE, loadExtensions, setErrorReporter } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { supportChatCustomer } from '@openora/core/engagement/schema/support-chat';
import { adminRole, adminRoleAssignment, adminRolePermission } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import {
  asAdmin,
  asPlayer,
  assignIamRoleByKey,
  bootE2e,
  clearCapturedEmails,
  closeE2e,
  registerAndMaterializePlayer,
  waitForEmail,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import {
  answerSupportHistoryWith,
  failSupportHistory,
  malformSupportHistory,
  readSupportHistoryCalls,
  resetSupportHistory,
} from '../test-support-history-plugin.js';

const historyPluginPath = fileURLToPath(
  new URL('../test-support-history-plugin.ts', import.meta.url),
);

const WAIT = { timeout: 15_000, interval: 50 };
const PASSWORD = 'password1234';
const SUPER_ADMIN_EMAIL = 'admin@oss.dev';
const GRANT_CACHE_TTL_FLOOR_MS = 10_000;
const POLL_UNDER_RATE_LIMIT_MS = 1_000;

let db: TestDb;
let unconfiguredDb: TestDb;
let testApp: TestApp;
let unconfiguredApp: TestApp;
let admin: TestClient;
let adminId: string;

const drizzle = () => testApp.container.get(DRIZZLE).db;
const historyPath = (userId: string, query = '') =>
  `/support-chat/admin/players/${userId}/history${query}`;

type Player = { client: TestClient; userId: string; playerId: string; email: string };

async function newPlayer(): Promise<Player> {
  const email = `support-history-${randomUUID()}@e2e.test`;
  return { ...(await registerAndMaterializePlayer(testApp, { email })), email };
}

async function linkedPlayer(): Promise<Player & { customerId: string }> {
  const p = await newPlayer();
  const customerId = `customer-${randomUUID()}`;
  await drizzle()
    .insert(supportChatCustomer)
    .values({ playerId: p.playerId, providerCustomerId: customerId });
  return { ...p, customerId };
}

const item = (
  kind: SupportHistoryItem['kind'],
  updatedAt: string,
  overrides: Partial<SupportHistoryItem> = {},
): SupportHistoryItem => {
  const id = randomUUID();
  return {
    kind,
    id,
    reference: `#${id.slice(0, 6)}`,
    subject: kind === 'ticket' ? 'Withdrawal question' : null,
    status: kind === 'ticket' ? 'open' : 'ended',
    assignee: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt,
    url: `https://agent.example.test/${kind}/${id}`,
    ...overrides,
  };
};

async function history(client: TestClient, userId: string, query = '') {
  const res = await client.get(historyPath(userId, query));
  expect(res.status, await res.clone().text()).toBe(200);
  return SupportHistorySchema.parse(await res.json());
}

/** A fresh staff account holding exactly one new role with `grants`. */
async function staffWithRole(grants: { resource: string; level: string }[]) {
  const email = `support-history-staff-${randomUUID()}@e2e.test`;
  const { userId } = await registerAndMaterializePlayer(testApp, { email });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const role = (await (
    await admin.post('/iam/roles', { name: `Support history ${userId}` })
  ).json()) as { id: string };
  expect((await admin.put(`/iam/roles/${role.id}/permissions`, { grants })).status).toBe(200);
  expect((await admin.post('/iam/assignments', { userId, roleId: role.id })).status).toBe(200);
  return { userId, client: await asAdmin(testApp.app, { email }) };
}

async function changeEmail(client: TestClient, newEmail: string) {
  clearCapturedEmails();
  const requested = await client.post('/identity/email/change/request', {
    newEmail,
    currentPassword: PASSWORD,
  });
  expect(requested.status).toBe(200);
  const mail = await waitForEmail(newEmail, (m) => m.subject === 'Confirm your new email address');
  const otp = /(\d{6})/.exec(mail.text)?.[1];
  expect((await client.post('/identity/email/change/confirm', { newEmail, otp })).status).toBe(200);
}

const emailChangeAuditedAt = (resourceType: 'player' | 'user', resourceId: string) =>
  vi.waitFor(async () => {
    const [row] = await drizzle()
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'identity.email.changed'),
          eq(auditLog.resourceType, resourceType),
          eq(auditLog.resourceId, resourceId),
        ),
      )
      .orderBy(asc(auditLog.seq));
    if (!row) {
      throw new Error('email change not audited yet');
    }
    const changedAt = row.after?.['changedAt'];
    if (typeof changedAt !== 'string') {
      throw new Error('email change audited without its change time');
    }
    return changedAt;
  }, WAIT);

/** Writes the player's confirmed email change row again, as a redelivered event would. */
async function redeliverEmailChange(
  playerId: string,
  rewrite: (after: Record<string, unknown>) => Record<string, unknown> = (after) => after,
) {
  const [row] = await drizzle()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'identity.email.changed'),
        eq(auditLog.resourceType, 'player'),
        eq(auditLog.resourceId, playerId),
      ),
    )
    .orderBy(asc(auditLog.seq));
  if (!row) {
    throw new Error('no email change to redeliver');
  }
  const { id: _id, seq: _seq, hash: _hash, ...rest } = row;
  await drizzle()
    .insert(auditLog)
    .values({ ...rest, after: rewrite(row.after ?? {}), hash: randomUUID() });
}

async function registeredAt(userId: string) {
  const [row] = await drizzle()
    .select({ createdAt: user.createdAt })
    .from(user)
    .where(eq(user.id, userId));
  return row?.createdAt.toISOString();
}

const supportViewer = () => staffWithRole([{ resource: 'support-chat', level: 'read' }]);

beforeAll(async () => {
  const extensions = await loadExtensions();
  ({ db, app: testApp } = await bootE2e({
    plugins: [...extensions, { id: 'testing-support-history', path: historyPluginPath }],
  }));
  admin = await asAdmin(testApp.app);
  const [row] = await drizzle()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, SUPER_ADMIN_EMAIL));
  adminId = row?.id ?? '';
  ({ db: unconfiguredDb, app: unconfiguredApp } = await bootE2e({ plugins: extensions }));
}, 60_000);

beforeEach(async () => {
  resetSupportHistory();
  await testApp.container
    .get(RATE_LIMITER)
    .reset(makeRateLimitKey(RATE_LIMIT_KEYS.SUPPORT_CHAT_HISTORY, adminId));
});

afterAll(async () => {
  await closeE2e({ app: unconfiguredApp, db: unconfiguredDb });
  await closeE2e({ app: testApp, db });
});

describe('GET /support-chat/admin/players/{userId}/history', () => {
  it('answers both sections newest first by real time, not string order, and passes includeResolved through', async () => {
    const p = await linkedPlayer();
    const older = item('ticket', '2026-03-01T10:00:00Z');
    const newer = item('ticket', '2026-03-01T10:00:00.500Z', { status: 'solved' });
    const oldest = item('ticket', '2026-02-01T08:00:00Z', { status: 'on_hold' });
    const chatOld = item('chat', '2026-02-02T00:00:00Z');
    const chatNew = item('chat', '2026-02-02T00:00:00.25Z', { status: 'active' });
    answerSupportHistoryWith({ tickets: [older, oldest, newer], chats: [chatOld, chatNew] });

    const body = await history(admin, p.userId);

    expect(body.tickets).toEqual({ state: 'ok', items: [newer, older, oldest], complete: true });
    expect(body.chats).toEqual({ state: 'ok', items: [chatNew, chatOld] });
    expect(readSupportHistoryCalls().listTickets.map((c) => c.includeResolved)).toEqual([false]);
    expect(readSupportHistoryCalls().listChats).toEqual([{ customerId: p.customerId }]);

    await history(admin, p.userId, '?includeResolved=true');
    expect(readSupportHistoryCalls().listTickets.map((c) => c.includeResolved)).toEqual([
      false,
      true,
    ]);
  });

  it('asks for the current email from registration when the player never changed it', async () => {
    const p = await newPlayer();

    await history(admin, p.userId);

    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: await registeredAt(p.userId), to: null },
    ]);
  });

  it('asks for the old email up to the change time the event carried and the new one after it', async () => {
    const p = await newPlayer();
    const newEmail = `support-history-new-${randomUUID()}@e2e.test`;
    await changeEmail(p.client, newEmail);
    const changedAt = await emailChangeAuditedAt('player', p.playerId);

    await history(admin, p.userId);

    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: await registeredAt(p.userId), to: changedAt },
      { email: newEmail, from: changedAt, to: null },
    ]);
  });

  it('reads an email change made before the player profile existed, and serves an uppercase id from the same cache entry', async () => {
    const p = await newPlayer();
    await drizzle().delete(player).where(eq(player.id, p.playerId));
    const newEmail = `support-history-new-${randomUUID()}@e2e.test`;
    await changeEmail(p.client, newEmail);
    const changedAt = await emailChangeAuditedAt('user', p.userId);
    const signedInAgain = await asPlayer(testApp.app, { email: newEmail, password: PASSWORD });
    expect((await signedInAgain.get('/profile')).status).toBe(200);

    await history(admin, p.userId.toUpperCase());
    await history(admin, p.userId);

    expect(readSupportHistoryCalls().listTickets).toHaveLength(1);
    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: await registeredAt(p.userId), to: changedAt },
      { email: newEmail, from: changedAt, to: null },
    ]);
  });

  it('windows two real email changes by the times their events carried', async () => {
    const p = await newPlayer();
    const second = `support-history-second-${randomUUID()}@e2e.test`;
    const third = `support-history-third-${randomUUID()}@e2e.test`;
    await changeEmail(p.client, second);
    const first = await emailChangeAuditedAt('player', p.playerId);
    const again = await asPlayer(testApp.app, { email: second, password: PASSWORD });
    await changeEmail(again, third);
    const rows = await vi.waitFor(async () => {
      const found = await drizzle()
        .select({ after: auditLog.after })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'identity.email.changed'),
            eq(auditLog.resourceType, 'player'),
            eq(auditLog.resourceId, p.playerId),
          ),
        )
        .orderBy(asc(auditLog.seq));
      if (found.length < 2) {
        throw new Error('second email change not audited yet');
      }
      return found;
    }, WAIT);
    const changedAts = rows.map((r) => String(r.after?.['changedAt']));
    expect(changedAts[0]).toBe(first);
    expect(Date.parse(changedAts[0] ?? '')).toBeLessThan(Date.parse(changedAts[1] ?? ''));

    await history(admin, p.userId);

    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: await registeredAt(p.userId), to: changedAts[0] },
      { email: second, from: changedAts[0], to: changedAts[1] },
      { email: third, from: changedAts[1], to: null },
    ]);
  });

  it('counts a redelivered email change once: the windows and the tickets stay as with one row', async () => {
    const p = await newPlayer();
    const newEmail = `support-history-new-${randomUUID()}@e2e.test`;
    await changeEmail(p.client, newEmail);
    const changedAt = await emailChangeAuditedAt('player', p.playerId);
    const ticket = item('ticket', '2026-03-01T00:00:00Z');
    answerSupportHistoryWith({ tickets: [ticket] });

    await redeliverEmailChange(p.playerId);
    const body = await history(admin, p.userId);

    expect(body.tickets).toEqual({ state: 'ok', items: [ticket], complete: true });
    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: await registeredAt(p.userId), to: changedAt },
      { email: newEmail, from: changedAt, to: null },
    ]);
  });

  it('searches only the current email, from the later time, for a repeated email change row with another change time', async () => {
    const p = await newPlayer();
    const newEmail = `support-history-new-${randomUUID()}@e2e.test`;
    await changeEmail(p.client, newEmail);
    await emailChangeAuditedAt('player', p.playerId);
    const later = '2099-01-01T00:00:00.000Z';

    await redeliverEmailChange(p.playerId, (after) => ({ ...after, changedAt: later }));
    const body = await history(admin, p.userId);

    expect(body.tickets).toEqual({ state: 'ok', items: [], complete: false });
    expect(readSupportHistoryCalls().listTickets.map((c) => c.windows)).toEqual([
      [{ email: newEmail, from: later, to: null }],
    ]);
  });

  it('answers tickets unavailable without asking the vendor when the email change trail contradicts itself', async () => {
    const p = await newPlayer();
    await drizzle()
      .insert(auditLog)
      .values({
        actorType: 'player',
        actorId: p.playerId,
        action: 'identity.email.changed',
        resourceType: 'player',
        resourceId: p.playerId,
        before: { email: `support-history-old-${randomUUID()}@e2e.test` },
        after: { email: `support-history-not-current-${randomUUID()}@e2e.test` },
        hash: randomUUID(),
      });

    const body = await history(admin, p.userId);

    expect(body.tickets).toEqual({ state: 'unavailable', items: [], complete: false });
    expect(readSupportHistoryCalls().listTickets).toEqual([]);
  });

  it('searches the emails after an old contradicting row and says the history is not complete', async () => {
    const p = await newPlayer();
    // Audited under the user, which the history reads too, so the real change below stays the
    // player's first row.
    await drizzle()
      .insert(auditLog)
      .values({
        actorType: 'player',
        actorId: p.playerId,
        action: 'identity.email.changed',
        resourceType: 'user',
        resourceId: p.userId,
        before: { email: `support-history-old-${randomUUID()}@e2e.test` },
        after: { email: `support-history-not-current-${randomUUID()}@e2e.test` },
        hash: randomUUID(),
      });
    const newEmail = `support-history-new-${randomUUID()}@e2e.test`;
    await changeEmail(p.client, newEmail);
    const changedAt = await emailChangeAuditedAt('player', p.playerId);
    const ticket = item('ticket', '2026-03-01T00:00:00Z');
    answerSupportHistoryWith({ tickets: [ticket] });

    const body = await history(admin, p.userId);

    expect(body.tickets).toEqual({ state: 'ok', items: [ticket], complete: false });
    expect(readSupportHistoryCalls().listTickets.map((c) => c.windows)).toEqual([
      [{ email: newEmail, from: changedAt, to: null }],
    ]);
  });

  it('answers chats not linked without asking the vendor for an unlinked player', async () => {
    const p = await newPlayer();
    answerSupportHistoryWith({ tickets: [item('ticket', '2026-03-01T00:00:00Z')] });

    const body = await history(admin, p.userId);

    expect(body.chats).toEqual({ state: 'not_linked', items: [] });
    expect(body.tickets.state).toBe('ok');
    expect(readSupportHistoryCalls().listChats).toEqual([]);
  });

  describe('a failing section', () => {
    it('answers tickets unavailable on a provider error and keeps the chats, the reason kept out of the response', async () => {
      const p = await linkedPlayer();
      const chat = item('chat', '2026-03-01T00:00:00Z');
      answerSupportHistoryWith({ chats: [chat] });
      failSupportHistory('listTickets', 'vendor answered 503');

      const res = await admin.get(historyPath(p.userId));
      const text = await res.clone().text();
      const body = SupportHistorySchema.parse(await res.json());

      expect(body.tickets).toEqual({ state: 'unavailable', items: [], complete: false });
      expect(body.chats).toEqual({ state: 'ok', items: [chat] });
      expect(text).not.toContain('vendor answered 503');
    });

    it('keeps a raw adapter error and its secret out of the response and the error reporter', async () => {
      const p = await linkedPlayer();
      const secret = `sk_live_${randomUUID()}`;
      const ticket = item('ticket', '2026-03-01T00:00:00Z');
      answerSupportHistoryWith({ tickets: [ticket] });
      failSupportHistory(
        'listChats',
        Object.assign(new Error(`GET https://vendor.example/chats?key=${secret} failed`), {
          config: { headers: { Authorization: `Bearer ${secret}` } },
        }),
      );
      const reported: unknown[] = [];
      setErrorReporter((error, context) => reported.push({ error, context }));
      try {
        const res = await admin.get(historyPath(p.userId));
        const text = await res.clone().text();
        const body = SupportHistorySchema.parse(await res.json());

        expect(body.chats).toEqual({ state: 'unavailable', items: [] });
        expect(body.tickets).toEqual({ state: 'ok', items: [ticket], complete: true });
        expect(text).not.toContain(secret);
        expect(inspect(reported, { depth: null })).not.toContain(secret);
      } finally {
        setErrorReporter(undefined);
      }
    });

    it('answers a section unavailable for a malformed item or a status of the other kind', async () => {
      const malformed = await linkedPlayer();
      answerSupportHistoryWith({ chats: [item('chat', '2026-03-01T00:00:00Z')] });
      malformSupportHistory('listTickets');
      const first = await history(admin, malformed.userId);
      expect(first.tickets).toEqual({ state: 'unavailable', items: [], complete: false });
      expect(first.chats.state).toBe('ok');

      resetSupportHistory();
      const wrongStatus = await linkedPlayer();
      answerSupportHistoryWith({
        tickets: [item('ticket', '2026-03-01T00:00:00Z', { status: 'active' })],
        chats: [item('chat', '2026-03-01T00:00:00Z')],
      });
      const second = await history(admin, wrongStatus.userId);
      expect(second.tickets).toEqual({ state: 'unavailable', items: [], complete: false });
      expect(second.chats.state).toBe('ok');

      resetSupportHistory();
      const wrongKind = await linkedPlayer();
      answerSupportHistoryWith({ chats: [item('ticket', '2026-03-01T00:00:00Z')] });
      const third = await history(admin, wrongKind.userId);
      expect(third.chats).toEqual({ state: 'unavailable', items: [] });
      expect(third.tickets.state).toBe('ok');
    });
  });

  describe('item links', () => {
    it.each([
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://agent.example.test/ticket/1',
      'https:../x',
      'https:evil.example',
    ])('answers only the section holding a link to %s unavailable', async (url) => {
      const p = await linkedPlayer();
      answerSupportHistoryWith({
        tickets: [item('ticket', '2026-03-01T00:00:00Z', { url })],
        chats: [item('chat', '2026-03-01T00:00:00Z')],
      });

      const body = await history(admin, p.userId);

      expect(body.tickets).toEqual({ state: 'unavailable', items: [], complete: false });
      expect(body.chats.state).toBe('ok');
      expect(body.chats.items).toHaveLength(1);
      expect(JSON.stringify(body)).not.toContain(url);
    });

    it.each(['https://agent.example.test/ticket/ok', 'HTTPS://agent.example.test'])(
      'passes the https link %s through unchanged',
      async (url) => {
        const p = await linkedPlayer();
        answerSupportHistoryWith({ tickets: [item('ticket', '2026-03-01T00:00:00Z', { url })] });

        const body = await history(admin, p.userId);

        expect(body.tickets.state).toBe('ok');
        expect(body.tickets.items.map((i) => i.url)).toEqual([url]);
      },
    );
  });

  describe('cache', () => {
    it('serves a repeat call inside a minute from the cache, fetchedAt included', async () => {
      const p = await linkedPlayer();
      const first = await history(admin, p.userId);
      const second = await history(admin, p.userId);

      expect(second).toEqual(first);
      expect(readSupportHistoryCalls().listTickets).toHaveLength(1);
      expect(readSupportHistoryCalls().listChats).toHaveLength(1);
    });

    it('caches each includeResolved apart and never serves another player', async () => {
      const p = await newPlayer();
      for (const query of [
        '',
        '?includeResolved=true',
        '?includeResolved=false',
        '?includeResolved=true',
      ]) {
        await history(admin, p.userId, query);
      }
      expect(readSupportHistoryCalls().listTickets.map((c) => c.includeResolved)).toEqual([
        false,
        true,
      ]);

      const other = await newPlayer();
      await history(admin, other.userId);
      expect(readSupportHistoryCalls().listTickets.at(-1)?.windows[0]?.email).toBe(other.email);
    });
  });

  describe('access', () => {
    it('lets the super admin and a role granting support-chat read in, and no other admin', async () => {
      const p = await newPlayer();
      const viewer = await supportViewer();
      const agentPlayer = await newPlayer();
      await assignIamRoleByKey(testApp.container, agentPlayer.userId, 'customer-support-agent');
      const agent = await asAdmin(testApp.app, { email: agentPlayer.email });

      expect((await admin.get(historyPath(p.userId))).status).toBe(200);
      expect((await viewer.client.get(historyPath(p.userId))).status).toBe(200);
      expect((await agent.get(historyPath(p.userId))).status).toBe(403);
    });

    it('refuses a player session with 403 and a guest with 401', async () => {
      const p = await newPlayer();
      const other = await newPlayer();
      const guest = await testApp.app.request(historyPath(other.userId));

      expect((await p.client.get(historyPath(other.userId))).status).toBe(403);
      expect(guest.status).toBe(401);
      expect(readSupportHistoryCalls().listTickets).toEqual([]);
    });

    it('lists the resource in the role catalog and grants it to no seeded role but the super admin', async () => {
      const catalog = (await (await admin.get('/iam/catalog')).json()) as {
        modules: { resource: string; actions: string[] }[];
      };
      expect(catalog.modules.find((m) => m.resource === 'support-chat')?.actions).toEqual(['view']);

      const seededHolders = await drizzle()
        .select({ key: adminRole.key })
        .from(adminRolePermission)
        .innerJoin(adminRole, eq(adminRole.id, adminRolePermission.roleId))
        .where(
          and(
            eq(adminRolePermission.resource, 'support-chat'),
            eq(adminRole.isSystem, true),
            eq(adminRole.isSuperAdmin, false),
            ne(adminRolePermission.level, 'no_access'),
          ),
        );
      expect(seededHolders).toEqual([]);
    });

    it('answers 404 for an unknown user and a user without a player profile, 400 for a non-UUID id', async () => {
      const [adminPlayer] = await drizzle()
        .select({ id: player.id })
        .from(player)
        .where(eq(player.userId, adminId));
      expect(adminPlayer).toBeUndefined();

      expect((await admin.get(historyPath(randomUUID()))).status).toBe(404);
      expect((await admin.get(historyPath(adminId))).status).toBe(404);
      expect((await admin.get(historyPath('not-a-uuid'))).status).toBe(400);
      expect(readSupportHistoryCalls()).toEqual({ listTickets: [], listChats: [] });
    });

    it('refuses a non-boolean includeResolved with 400 before the reader is reached', async () => {
      const p = await newPlayer();
      for (const value of ['1', 'yes', 'TRUE', '', 'true&includeResolved=false']) {
        const res = await admin.get(historyPath(p.userId, `?includeResolved=${value}`));
        expect(res.status, value).toBe(400);
      }
      expect(readSupportHistoryCalls().listTickets).toEqual([]);
    });

    it('stops answering an admin whose role is withdrawn, though the answer is still cached', async () => {
      const p = await newPlayer();
      const viewer = await supportViewer();
      const [assignment] = await drizzle()
        .select({ roleId: adminRoleAssignment.roleId })
        .from(adminRoleAssignment)
        .where(eq(adminRoleAssignment.userId, viewer.userId));
      expect((await viewer.client.get(historyPath(p.userId))).status).toBe(200);

      const withdrawn = await admin.request('/iam/assignments', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: viewer.userId, roleId: assignment?.roleId }),
      });
      expect(withdrawn.status).toBe(200);

      await vi.waitFor(
        async () => expect((await viewer.client.get(historyPath(p.userId))).status).toBe(403),
        { timeout: 2 * GRANT_CACHE_TTL_FLOOR_MS, interval: POLL_UNDER_RATE_LIMIT_MS },
      );
      expect(readSupportHistoryCalls().listTickets).toHaveLength(1);
    });

    it('limits each admin to 30 calls a minute, cache hits included, and leaves another admin alone', async () => {
      const p = await newPlayer();
      const viewer = await supportViewer();
      const another = await supportViewer();
      for (let call = 0; call < 30; call++) {
        expect((await viewer.client.get(historyPath(p.userId))).status).toBe(200);
      }
      expect((await viewer.client.get(historyPath(p.userId))).status).toBe(429);
      expect((await another.client.get(historyPath(p.userId))).status).toBe(200);
    });
  });
});

describe('ports bound apart', () => {
  it('answers 503 not configured with no reader bound', async () => {
    const unconfiguredAdmin = await asAdmin(unconfiguredApp.app);
    const res = await unconfiguredAdmin.get(historyPath(randomUUID()));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ message: 'Support history is not configured' });
  });

  it('serves the history with no chat provider bound, while the session route is not configured', async () => {
    const p = await newPlayer();
    await history(admin, p.userId);

    const res = await p.client.post('/support-chat/session');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ message: 'Support chat is not configured' });
  });
});

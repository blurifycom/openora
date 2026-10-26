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
import { DRIZZLE, createLogger, loadExtensions, setErrorReporter } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { supportChatCustomer } from '@openora/core/engagement/schema/support-chat';
import { adminRole, adminRolePermission } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import {
  asAdmin,
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

const WARN = 40;
type Written = { fields: unknown; msg: unknown };
const warnings: Written[] = [];

/**
 * Records every warning any logger writes, then writes it as usual. This tier loads core's
 * compiled modules as is, so a module mock never reaches the plugin's logger: every pino logger
 * writes through one shared prototype method instead, and that is where the warnings are read.
 */
function recordWarnings(): () => void {
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(createLogger('e2e-probe'))) as Record<
    symbol,
    (this: unknown, fields: unknown, msg: unknown, level: number) => void
  >;
  const writeSym = Object.getOwnPropertySymbols(proto).find((s) => s.description === 'pino.write');
  const write = writeSym && proto[writeSym];
  if (!writeSym || !write) {
    throw new Error('pino write method not found - the logger internals moved');
  }
  proto[writeSym] = function (fields, msg, level) {
    if (level === WARN) {
      warnings.push({ fields, msg });
    }
    write.call(this, fields, msg, level);
  };
  return () => {
    proto[writeSym] = write;
  };
}

let stopRecording: () => void = () => undefined;

const historyPluginPath = fileURLToPath(
  new URL('../test-support-history-plugin.ts', import.meta.url),
);

const WAIT = { timeout: 15_000, interval: 50 };
const PASSWORD = 'password1234';
const SUPER_ADMIN_EMAIL = 'admin@oss.dev';

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

const supportViewer = () => staffWithRole([{ resource: 'support-chat', level: 'read' }]);

const historyWarnings = (userId: string) =>
  warnings
    .map(({ fields }) => fields)
    .filter(
      (fields): fields is Record<string, unknown> =>
        typeof fields === 'object' &&
        fields !== null &&
        (fields as { userId?: unknown }).userId === userId,
    );

beforeAll(async () => {
  stopRecording = recordWarnings();
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
  // Its own database: on a shared one its outbox relay would claim the other app's events.
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
  stopRecording();
});

describe('GET /support-chat/admin/players/{userId}/history', () => {
  it('answers both sections sorted by real time, newest first, and passes includeResolved through', async () => {
    const p = await linkedPlayer();
    // String order would put the whole second before the half second after it.
    const older = item('ticket', '2026-03-01T10:00:00Z');
    const newer = item('ticket', '2026-03-01T10:00:00.500Z', { status: 'solved' });
    const oldest = item('ticket', '2026-02-01T08:00:00Z', { status: 'on_hold' });
    const chatOld = item('chat', '2026-02-02T00:00:00Z');
    const chatNew = item('chat', '2026-02-02T00:00:00.25Z', { status: 'active' });
    answerSupportHistoryWith({ tickets: [older, oldest, newer], chats: [chatOld, chatNew] });

    const body = await history(admin, p.userId);

    expect(body.tickets).toEqual({ state: 'ok', items: [newer, older, oldest] });
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
    const [row] = await drizzle()
      .select({ createdAt: user.createdAt })
      .from(user)
      .where(eq(user.id, p.userId));

    await history(admin, p.userId);

    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: row?.createdAt.toISOString(), to: null },
    ]);
  });

  it('asks for the old email up to the change and the new one after it', async () => {
    const p = await newPlayer();
    const newEmail = `support-history-new-${randomUUID()}@e2e.test`;
    clearCapturedEmails();
    expect(
      (
        await p.client.post('/identity/email/change/request', {
          newEmail,
          currentPassword: PASSWORD,
        })
      ).status,
    ).toBe(200);
    const mail = await waitForEmail(
      newEmail,
      (m) => m.subject === 'Confirm your new email address',
    );
    const otp = /(\d{6})/.exec(mail.text)?.[1];
    expect((await p.client.post('/identity/email/change/confirm', { newEmail, otp })).status).toBe(
      200,
    );
    const changedAt = await vi.waitFor(async () => {
      const [row] = await drizzle()
        .select({ createdAt: auditLog.createdAt })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'identity.email.changed'), eq(auditLog.resourceId, p.playerId)),
        )
        .orderBy(asc(auditLog.seq));
      if (!row) {
        throw new Error('email change not audited yet');
      }
      return row.createdAt.toISOString();
    }, WAIT);
    const [registered] = await drizzle()
      .select({ createdAt: user.createdAt })
      .from(user)
      .where(eq(user.id, p.userId));

    await history(admin, p.userId);

    expect(readSupportHistoryCalls().listTickets[0]?.windows).toEqual([
      { email: p.email, from: registered?.createdAt.toISOString(), to: changedAt },
      { email: newEmail, from: changedAt, to: null },
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
    it('answers tickets unavailable on a provider error and keeps the chats, reason in the log only', async () => {
      const p = await linkedPlayer();
      const chat = item('chat', '2026-03-01T00:00:00Z');
      answerSupportHistoryWith({ chats: [chat] });
      failSupportHistory('listTickets', 'vendor answered 503');

      const res = await admin.get(historyPath(p.userId));
      const text = await res.clone().text();
      const body = SupportHistorySchema.parse(await res.json());

      expect(body.tickets).toEqual({ state: 'unavailable', items: [] });
      expect(body.chats).toEqual({ state: 'ok', items: [chat] });
      expect(text).not.toContain('vendor answered 503');
      expect(historyWarnings(p.userId)).toEqual([
        { userId: p.userId, section: 'ticket', reason: 'vendor answered 503' },
      ]);
    });

    it('keeps a raw adapter error and its secret out of the response, the log and the error reporter', async () => {
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
        expect(body.tickets).toEqual({ state: 'ok', items: [ticket] });
        expect(text).not.toContain(secret);
        expect(historyWarnings(p.userId)).toEqual([
          { userId: p.userId, section: 'chat', reason: 'adapter threw Error' },
        ]);
        expect(inspect([reported, warnings], { depth: null })).not.toContain(secret);
      } finally {
        setErrorReporter(undefined);
      }
    });

    it('answers a section unavailable for a malformed item or a status of the other kind', async () => {
      const malformed = await linkedPlayer();
      answerSupportHistoryWith({ chats: [item('chat', '2026-03-01T00:00:00Z')] });
      malformSupportHistory('listTickets');
      const first = await history(admin, malformed.userId);
      expect(first.tickets).toEqual({ state: 'unavailable', items: [] });
      expect(first.chats.state).toBe('ok');

      resetSupportHistory();
      const wrongStatus = await linkedPlayer();
      answerSupportHistoryWith({
        tickets: [item('ticket', '2026-03-01T00:00:00Z', { status: 'active' })],
        chats: [item('chat', '2026-03-01T00:00:00Z')],
      });
      const second = await history(admin, wrongStatus.userId);
      expect(second.tickets).toEqual({ state: 'unavailable', items: [] });
      expect(second.chats.state).toBe('ok');

      resetSupportHistory();
      const wrongKind = await linkedPlayer();
      answerSupportHistoryWith({ chats: [item('ticket', '2026-03-01T00:00:00Z')] });
      const third = await history(admin, wrongKind.userId);
      expect(third.chats).toEqual({ state: 'unavailable', items: [] });
      expect(third.tickets.state).toBe('ok');
    });
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
  it('answers 503 not configured with no reader bound, warning once at boot', async () => {
    const unconfiguredAdmin = await asAdmin(unconfiguredApp.app);
    const res = await unconfiguredAdmin.get(historyPath(randomUUID()));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ message: 'Support history is not configured' });
    expect(
      warnings.filter(({ msg }) => String(msg).includes('no SUPPORT_HISTORY_READER bound')),
    ).toHaveLength(1);
  });

  it('serves the history with no chat provider bound, while the session route is not configured', async () => {
    const p = await newPlayer();
    await history(admin, p.userId);

    const res = await p.client.post('/support-chat/session');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ message: 'Support chat is not configured' });
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { PLAYER_ACCOUNT_MANAGER_READER } from '@openora/core/contracts';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  deactivateUser,
  newPlayer,
  newStaff,
  type NamedAccount,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import { readSupportChatCalls, resetSupportChat } from '../test-support-chat-plugin.js';

const CANDIDATES = '/players/account-managers';
const ASSIGNED = '/players/account-managers/assigned';
const EMAIL_PREFIX = 'account-manager-email';
const WAIT = { timeout: 15_000, interval: 50 };
const SUPPORT_CHAT_CONTEXT_KEYS = [
  'accountManagerName',
  'accountStatus',
  'activeCurrency',
  'email',
  'isCoolingOff',
  'isSelfExcluded',
  'kycStatus',
  'playerId',
  'rankName',
  'syncedAt',
  'userId',
  'username',
];

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;

const drizzle = () => testApp.container.get(DRIZZLE).db;

async function assign(playerId: string, accountManagerId: string | null) {
  const res = await admin.put(`/players/${playerId}/account-manager`, { accountManagerId });
  expect(res.status, await res.clone().text()).toBe(200);
  return res;
}

/** Same name for all, emails in the REVERSE of the user-id order, so an email sort would show. */
async function namesakes(token: string, count: number): Promise<NamedAccount[]> {
  const staff: NamedAccount[] = [];
  for (let i = 0; i < count; i++) {
    staff.push(await newStaff(testApp, EMAIL_PREFIX, 'vip-manager', `${token} Platform Admin`));
  }
  staff.sort((a, b) => (a.userId < b.userId ? -1 : 1));
  const emails = staff.map((_, i) => `${token}-${String(count - i).padStart(2, '0')}@e2e.test`);
  for (const [i, account] of staff.entries()) {
    const email = emails[i] as string;
    await drizzle().update(user).set({ email }).where(eq(user.id, account.userId));
    account.email = email;
  }
  return staff;
}

const storedEmail = async (userId: string) => {
  const [row] = await drizzle().select({ email: user.email }).from(user).where(eq(user.id, userId));
  return row?.email;
};

beforeAll(async () => {
  resetSupportChat();
  const extensions = await loadExtensions();
  ({ db, app: testApp } = await bootE2e({
    plugins: [
      ...extensions,
      {
        id: 'testing-support-chat',
        path: fileURLToPath(new URL('../test-support-chat-plugin.ts', import.meta.url)),
      },
    ],
  }));
  admin = await asAdmin(testApp.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app: testApp, db });
});

describe('account manager lists carry the staff email', () => {
  it('candidates are exactly userId, name, email, and the email is the stored one', async () => {
    const token = randomUUID().slice(0, 8);
    const staff = await newStaff(testApp, EMAIL_PREFIX, 'vip-manager', `${token} solo`);

    const res = await admin.get(`${CANDIDATES}?search=${token}`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as Record<string, unknown>[];
    expect(entries).toEqual([
      { userId: staff.userId, name: staff.name, email: await storedEmail(staff.userId) },
    ]);
    expect(Object.keys(entries[0] as object).sort()).toEqual(['email', 'name', 'userId']);
  });

  it('assigned entries are exactly userId, name, email, isActive, a deactivated manager included', async () => {
    const token = randomUUID().slice(0, 8);
    const active = await newStaff(testApp, EMAIL_PREFIX, 'vip-manager', `${token} active`);
    const inactive = await newStaff(testApp, EMAIL_PREFIX, 'vip-manager', `${token} inactive`);
    await assign((await newPlayer(testApp, EMAIL_PREFIX)).playerId, active.userId);
    await assign((await newPlayer(testApp, EMAIL_PREFIX)).playerId, inactive.userId);
    await deactivateUser(testApp, inactive.userId);

    const res = await admin.get(ASSIGNED);
    expect(res.status).toBe(200);
    const mine = ((await res.json()) as { name: string }[]).filter(({ name }) =>
      name.startsWith(token),
    );
    expect(mine).toEqual([
      {
        userId: active.userId,
        name: active.name,
        email: await storedEmail(active.userId),
        isActive: true,
      },
      {
        userId: inactive.userId,
        name: inactive.name,
        email: await storedEmail(inactive.userId),
        isActive: false,
      },
    ]);
    for (const entry of mine) {
      expect(Object.keys(entry).sort()).toEqual(['email', 'isActive', 'name', 'userId']);
    }
  });

  it('keeps same-named staff apart in both lists, ordered by user id and never by email', async () => {
    const token = randomUUID().slice(0, 8);
    const staff = await namesakes(token, 4);
    for (const account of staff) {
      await assign((await newPlayer(testApp, EMAIL_PREFIX)).playerId, account.userId);
    }
    const expected = staff.map(({ userId, email }) => ({ userId, email }));
    const emailOrder = [...staff].sort((a, b) => (a.email < b.email ? -1 : 1));
    expect(emailOrder.map(({ userId }) => userId)).not.toEqual(staff.map(({ userId }) => userId));

    const candidates = (await (await admin.get(`${CANDIDATES}?search=${token}`)).json()) as {
      userId: string;
      email: string;
    }[];
    expect(candidates.map(({ userId, email }) => ({ userId, email }))).toEqual(expected);

    const assigned = (
      (await (await admin.get(ASSIGNED)).json()) as {
        userId: string;
        name: string;
        email: string;
      }[]
    ).filter(({ name }) => name.startsWith(token));
    expect(assigned.map(({ userId, email }) => ({ userId, email }))).toEqual(expected);
  });

  it('refuses limit 0, -1, 51 and non-numbers, caps at limit and matches by name only', async () => {
    const token = randomUUID().slice(0, 8);
    await namesakes(token, 3);
    for (const bad of ['0', '-1', '51', 'abc', '1.5']) {
      expect((await admin.get(`${CANDIDATES}?limit=${bad}`)).status, `limit=${bad}`).toBe(400);
    }
    expect(
      (await (await admin.get(`${CANDIDATES}?search=${token}&limit=1`)).json()) as unknown[],
    ).toHaveLength(1);
    expect(
      await (await admin.get(`${CANDIDATES}?search=${encodeURIComponent('@e2e.test')}`)).json(),
    ).toEqual([]);
    expect(await (await admin.get(`${CANDIDATES}?search=${token}-0`)).json()).toEqual([]);
    expect((await admin.get(`${CANDIDATES}?search=${'a'.repeat(101)}`)).status).toBe(400);
  });

  it('excludes inactive staff, staff without player:view and non-staff roles from candidates', async () => {
    const token = randomUUID().slice(0, 8);
    const eligible = await newStaff(testApp, EMAIL_PREFIX, 'vip-manager', `${token} ok`);
    const inactive = await newStaff(testApp, EMAIL_PREFIX, 'vip-manager', `${token} inactive`);
    await deactivateUser(testApp, inactive.userId);
    await newStaff(testApp, EMAIL_PREFIX, 'marketing-banners', `${token} no-view`);
    const player = await newPlayer(testApp, EMAIL_PREFIX, `${token} player`);

    const entries = (await (await admin.get(`${CANDIDATES}?search=${token}`)).json()) as {
      userId: string;
    }[];
    expect(entries.map(({ userId }) => userId)).toEqual([eligible.userId]);
    expect(JSON.stringify(entries)).not.toContain(player.email);
    expect(JSON.stringify(entries)).not.toContain(inactive.email);
  });
});

describe('who may read the emails', () => {
  it('serves player:view staff, refuses a role without it and a player with 403, and no session with 401', async () => {
    const viewer = await newStaff(testApp, EMAIL_PREFIX, 'customer-support-agent');
    const outsider = await newStaff(testApp, EMAIL_PREFIX, 'marketing-banners');
    const player = await newPlayer(testApp, EMAIL_PREFIX);
    const manager = await newStaff(testApp, EMAIL_PREFIX, 'vip-manager');
    await assign(player.playerId, manager.userId);

    for (const path of [CANDIDATES, ASSIGNED]) {
      expect((await viewer.client.get(path)).status, `viewer ${path}`).toBe(200);
      for (const [who, client] of [
        ['outsider', outsider.client],
        ['player', player.client],
      ] as const) {
        const res = await client.get(path);
        expect(res.status, `${who} ${path}`).toBe(403);
        expect(await res.text()).not.toContain(manager.email);
      }
      expect((await testApp.app.request(path, { method: 'GET' })).status).toBe(401);
    }
  });
});

describe('the manager email never reaches the player or the support-chat vendor', () => {
  it('keeps it out of the player profile, profile card and support-chat session', async () => {
    const p = await newPlayer(testApp, EMAIL_PREFIX);
    const manager = await newStaff(testApp, EMAIL_PREFIX, 'vip-manager');
    await assign(p.playerId, manager.userId);

    const session = await p.client.post('/support-chat/session');
    expect(session.status).toBe(200);
    for (const res of [
      await p.client.get('/profile'),
      await p.client.get(`/players/${p.userId}/profile-card`),
      session,
    ]) {
      expect(res.status).toBe(200);
      const text = await res.clone().text();
      expect(text).not.toContain(manager.email);
      expect(text).not.toContain(manager.name);
      expect(JSON.parse(text)).not.toHaveProperty('accountManager');
    }
  });

  it('syncs the manager name only: same context keys, the email nowhere in what the vendor got', async () => {
    const p = await newPlayer(testApp, EMAIL_PREFIX);
    const manager = await newStaff(testApp, EMAIL_PREFIX, 'vip-manager');
    const customerId = String(
      ((await (await p.client.post('/support-chat/session')).json()) as { customerId: string })
        .customerId,
    );
    await assign(p.playerId, manager.userId);

    await vi.waitFor(() => {
      const last = readSupportChatCalls()
        .syncs.filter((s) => s.customerId === customerId)
        .at(-1);
      expect(last?.context.accountManagerName).toBe(manager.name);
    }, WAIT);

    const everything = JSON.stringify(readSupportChatCalls());
    expect(everything).not.toContain(manager.email);
    for (const sync of readSupportChatCalls().syncs.filter((s) => s.customerId === customerId)) {
      expect(Object.keys(sync.context).sort()).toEqual(SUPPORT_CHAT_CONTEXT_KEYS);
    }
  });
});

describe('the shared manager shape stays email-free', () => {
  it('leaves email out of the reader port and out of every player-record response', async () => {
    const p = await newPlayer(testApp, EMAIL_PREFIX);
    const manager = await newStaff(testApp, EMAIL_PREFIX, 'vip-manager');
    const put = await assign(p.playerId, manager.userId);

    const read = await testApp.container
      .get(PLAYER_ACCOUNT_MANAGER_READER)
      .getByPlayerUserId(p.userId);
    expect(Object.keys(read ?? {}).sort()).toEqual(['isActive', 'name', 'userId']);

    const responses = [
      put,
      await admin.get(`/players/${p.playerId}`),
      await admin.get(`/players?accountManagerId=${manager.userId}`),
      await admin.patch(`/players/${p.playerId}`, { status: 'suspended' }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(await res.clone().text()).not.toContain(manager.email);
    }
    expect(((await put.json()) as { accountManager: object }).accountManager).toEqual({
      userId: manager.userId,
      name: manager.name,
      isActive: true,
    });
  });
});

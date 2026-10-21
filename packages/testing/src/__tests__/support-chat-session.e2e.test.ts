import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  JOB_QUEUE,
  RG_EXCLUSION_READER,
  SUPPORT_CHAT_PROVIDER,
  SupportCustomerContextSchema,
  WALLET_READER,
  queue,
} from '@openora/core/contracts';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { rgExclusion } from '@openora/core/compliance/schema';
import { SupportChatService } from '@openora/core/engagement/server';
import { supportChatCustomer } from '@openora/core/engagement/schema/support-chat';
import { player } from '@openora/core/pam/schema/profile';
import {
  asAdmin,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import {
  answerNextSupportChatTokenWith,
  failNextSupportChatToken,
  holdNextSupportChatSync,
  malformNextSupportChatToken,
  readSupportChatCalls,
  resetSupportChat,
  setSupportChatSyncDelay,
} from '../test-support-chat-plugin.js';

const supportChatPluginPath = fileURLToPath(
  new URL('../test-support-chat-plugin.ts', import.meta.url),
);

const WAIT = { timeout: 15_000, interval: 50 };
const SESSION = '/support-chat/session';
const CONTEXT_KEYS = [
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
let unconfiguredDb: TestDb;
let testApp: TestApp;
let unconfiguredApp: TestApp;
let admin: TestClient;

type Player = { client: TestClient; userId: string; playerId: string; email: string };

async function newPlayer(app: TestApp = testApp): Promise<Player> {
  const email = `support-chat-${randomUUID()}@e2e.test`;
  return { ...(await registerAndMaterializePlayer(app, { email })), email };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function openSession(client: TestClient): Promise<string> {
  const res = await client.post(SESSION);
  expect(res.status).toBe(200);
  const token = await body(res);
  return String(token['customerId']);
}

const syncsFor = (customerId: string) =>
  readSupportChatCalls().syncs.filter((sync) => sync.customerId === customerId);

const lastSyncFor = (customerId: string) => syncsFor(customerId).at(-1);

async function waitForSyncs(customerId: string, count: number) {
  await vi.waitFor(() => expect(syncsFor(customerId).length).toBeGreaterThanOrEqual(count), WAIT);
}

const linkRows = (playerId: string) =>
  testApp.container
    .get(DRIZZLE)
    .db.select()
    .from(supportChatCustomer)
    .where(eq(supportChatCustomer.playerId, playerId));

const enqueueSync = (userId: string) =>
  testApp.container
    .get(JOB_QUEUE)
    .enqueue(queue('support-chat.sync-customer'), { userId }, { attempts: 1 });

/** Links a player, waits for the open's own sync, then changes the database and syncs again. */
async function contextAfter(change: (p: Player) => Promise<void>) {
  const p = await newPlayer();
  const customerId = await openSession(p.client);
  await waitForSyncs(customerId, 1);
  await change(p);
  await enqueueSync(p.userId);
  await waitForSyncs(customerId, 2);
  return lastSyncFor(customerId)?.context;
}

const insertExclusion = (values: Omit<typeof rgExclusion.$inferInsert, 'reason' | 'createdBy'>) =>
  testApp.container
    .get(DRIZZLE)
    .db.insert(rgExclusion)
    .values({ reason: 'e2e', createdBy: randomUUID(), ...values });

const HOUR_AGO = () => new Date(Date.now() - 3_600_000);

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';
  db = await setupTestDb();
  const extensions = await loadExtensions();
  testApp = await bootTestApp({
    plugins: [...extensions, { id: 'testing-support-chat', path: supportChatPluginPath }],
    databaseUrl: db.url,
  });
  await seedMinimal(testApp.container, { playerCount: 0 });
  admin = await asAdmin(testApp.app);
  // Its own database: on a shared one its outbox relay would claim the other app's events.
  unconfiguredDb = await setupTestDb();
  unconfiguredApp = await bootTestApp({ plugins: extensions, databaseUrl: unconfiguredDb.url });
  resetSupportChat();
}, 60_000);

afterEach(() => {
  setSupportChatSyncDelay(0);
});

afterAll(async () => {
  await unconfiguredApp?.close();
  await testApp?.close();
  await db?.dispose();
  await unconfiguredDb?.dispose();
});

describe('POST /support-chat/session', () => {
  it('links one vendor customer on first open, reuses it after, and syncs only the support context', async () => {
    const p = await newPlayer();
    const res = await p.client.post(SESSION);
    expect(res.status).toBe(200);
    const first = await body(res);
    expect(first).toEqual({
      customerId: expect.any(String),
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresInMs: 3_600_000,
    });
    const customerId = String(first['customerId']);

    expect(await openSession(p.client)).toBe(customerId);
    const requests = readSupportChatCalls().tokenRequests;
    expect(requests.filter((r) => r.customerId === customerId)).toHaveLength(1);
    expect(await linkRows(p.playerId)).toHaveLength(1);

    await waitForSyncs(customerId, 1);
    const context = lastSyncFor(customerId)?.context;
    expect(Object.keys(context ?? {}).sort()).toEqual(CONTEXT_KEYS);
    expect(context).toMatchObject({
      playerId: p.playerId,
      userId: p.userId,
      email: p.email,
      username: expect.any(String),
      accountStatus: 'active',
      isSelfExcluded: false,
      isCoolingOff: false,
      activeCurrency: expect.any(String),
    });
  });

  it('refuses a guest with 401', async () => {
    const res = await testApp.app.request(SESSION, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it("answers 429 on a player's 11th call in a minute while another player still gets 200", async () => {
    const { client } = await newPlayer();
    for (let call = 0; call < 10; call++) {
      expect((await client.post(SESSION)).status).toBe(200);
    }
    expect((await client.post(SESSION)).status).toBe(429);
    expect((await (await newPlayer()).client.post(SESSION)).status).toBe(200);
  });

  it('answers 503 not configured when no provider is bound', async () => {
    const { client } = await newPlayer(unconfiguredApp);
    const res = await client.post(SESSION);
    expect(res.status).toBe(503);
    expect(await body(res)).toMatchObject({ message: 'Support chat is not configured' });
  });

  it.each([
    ['refuses', () => failNextSupportChatToken('vendor said no')],
    ['answers a malformed token', () => malformNextSupportChatToken()],
  ])(
    'answers a generic 503 when the vendor %s, then serves the next call',
    async (_case, steer) => {
      const { client, playerId } = await newPlayer();
      steer();
      const refused = await client.post(SESSION);
      expect(refused.status).toBe(503);
      const error = await body(refused);
      expect(error['message']).toBe('Support chat is unavailable');
      expect(error['data']).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain('vendor said no');
      expect(await linkRows(playerId)).toHaveLength(0);

      expect((await client.post(SESSION)).status).toBe(200);
    },
  );

  it('answers 503 when the vendor issues a token for another customer than the linked one', async () => {
    const { client } = await newPlayer();
    await openSession(client);
    answerNextSupportChatTokenWith(`customer-${randomUUID()}`);
    expect((await client.post(SESSION)).status).toBe(503);
  });

  it("fails with 500 and links nothing when the vendor hands out another player's customer", async () => {
    const owner = await newPlayer();
    const ownersCustomer = await openSession(owner.client);
    const other = await newPlayer();
    answerNextSupportChatTokenWith(ownersCustomer);
    expect((await other.client.post(SESSION)).status).toBe(500);
    expect(await linkRows(other.playerId)).toHaveLength(0);
    expect(await linkRows(owner.playerId)).toEqual([
      expect.objectContaining({ providerCustomerId: ownersCustomer }),
    ]);
  });

  it('returns before a slow vendor write and the write lands through the job', async () => {
    setSupportChatSyncDelay(1_000);
    const { client } = await newPlayer();
    const customerId = await openSession(client);
    expect(syncsFor(customerId)).toHaveLength(0);
    await waitForSyncs(customerId, 1);
  });

  it('links exactly one customer for three concurrent first opens and audits it once', async () => {
    const p = await newPlayer();
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        p.client.request(SESSION, {
          method: 'POST',
          headers: { 'x-real-ip': '203.0.113.7', 'user-agent': 'support-chat-e2e' },
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const customers = await Promise.all(responses.map(async (r) => (await body(r))['customerId']));
    const rows = await linkRows(p.playerId);
    expect(rows).toHaveLength(1);
    expect(new Set(customers)).toEqual(new Set([rows[0]?.providerCustomerId]));

    const audits = await testApp.container
      .get(DRIZZLE)
      .db.select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'support_chat.customer.linked'),
          eq(auditLog.resourceId, p.playerId),
        ),
      );
    expect(audits).toEqual([
      expect.objectContaining({
        actorType: 'player',
        actorId: p.userId,
        resourceType: 'support_chat_customer',
        ip: '203.0.113.7',
        userAgent: 'support-chat-e2e',
        after: { providerCustomerId: rows[0]?.providerCustomerId },
      }),
    ]);
  });
});

describe('support context reads responsible gambling the way compliance does', () => {
  it('treats a lifted self-exclusion as not excluded', async () => {
    const context = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'self_exclusion',
        status: 'lifted',
        isPermanent: true,
        liftedAt: new Date(),
      }).then(() => undefined),
    );
    expect(context).toMatchObject({ isSelfExcluded: false, accountStatus: 'active' });
  });

  it('ends a cooling-off at its expiry before the sweep marks it', async () => {
    const context = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'cooling_off',
        status: 'active',
        expiresAt: HOUR_AGO(),
      }).then(() => undefined),
    );
    expect(context).toMatchObject({ isCoolingOff: false });
  });

  it('keeps a fixed-term self-exclusion binding past its expiry until it is lifted', async () => {
    const context = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'self_exclusion',
        status: 'active',
        isPermanent: false,
        expiresAt: HOUR_AGO(),
      }).then(() => undefined),
    );
    expect(context).toMatchObject({ isSelfExcluded: true, accountStatus: 'self_excluded' });
  });

  it('keeps a closed account closed while still flagging its self-exclusion', async () => {
    const context = await contextAfter(async (p) => {
      await insertExclusion({
        userId: p.userId,
        kind: 'self_exclusion',
        status: 'active',
        isPermanent: true,
      });
      await testApp.container
        .get(DRIZZLE)
        .db.update(player)
        .set({ status: 'closed' })
        .where(eq(player.id, p.playerId));
    });
    expect(context).toMatchObject({ isSelfExcluded: true, accountStatus: 'closed' });
  });
});

describe('support-chat session edge cases and RG attacks', () => {
  it('asks the vendor for a new customer first and for the linked one after, and stamps a recent syncedAt', async () => {
    const p = await newPlayer();
    const customerId = await openSession(p.client);
    await openSession(p.client);
    await waitForSyncs(customerId, 1);
    const requests = readSupportChatCalls().tokenRequests;
    const mine = requests.filter((r) => r.customerId === customerId);
    expect(mine).toHaveLength(1);
    expect(requests.filter((r) => r.customerId === undefined).length).toBeGreaterThanOrEqual(1);
    expect(requests.findIndex((r) => r.customerId === customerId)).toBeGreaterThan(
      requests.findIndex((r) => r.customerId === undefined),
    );
    const syncedAt = Date.parse(String(lastSyncFor(customerId)?.context.syncedAt));
    expect(Math.abs(Date.now() - syncedAt)).toBeLessThan(60_000);
  });

  it('has a sent context the strict schema accepts and rejects once any extra key is added', async () => {
    const p = await newPlayer();
    const customerId = await openSession(p.client);
    await waitForSyncs(customerId, 1);
    const context = lastSyncFor(customerId)?.context;
    expect(SupportCustomerContextSchema.safeParse(context).success).toBe(true);
    expect(SupportCustomerContextSchema.safeParse({ ...context, balance: 1 }).success).toBe(false);
  });

  it('gives an admin without a player profile a refusal and no link', async () => {
    const res = await admin.post(SESSION);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('treats a lifted cooling-off with a future expiry as not cooling off and an active one as cooling off', async () => {
    const lifted = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'cooling_off',
        status: 'lifted',
        expiresAt: new Date(Date.now() + 3_600_000),
        liftedAt: new Date(),
      }).then(() => undefined),
    );
    expect(lifted).toMatchObject({ isCoolingOff: false });
    const active = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'cooling_off',
        status: 'active',
        expiresAt: new Date(Date.now() + 3_600_000),
      }).then(() => undefined),
    );
    expect(active).toMatchObject({ isCoolingOff: true, isSelfExcluded: false });
  });

  it('does not bind an expired-status self-exclusion', async () => {
    const context = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'self_exclusion',
        status: 'expired',
        isPermanent: false,
        expiresAt: HOUR_AGO(),
      }).then(() => undefined),
    );
    expect(context).toMatchObject({ isSelfExcluded: false, accountStatus: 'active' });
  });
});

describe('support context refresh', () => {
  it('refreshes a linked player on a cooling-off and skips a player who never opened the chat', async () => {
    const neverOpened = await newPlayer();
    const linked = await newPlayer();
    const customerId = await openSession(linked.client);
    await waitForSyncs(customerId, 1);

    for (const userId of [neverOpened.userId, linked.userId]) {
      const res = await admin.post(`/compliance/players/${userId}/cooling-off`, {
        durationHours: 24,
        reason: 'support-chat refresh e2e',
      });
      expect(res.status).toBe(200);
    }

    await vi.waitFor(() => expect(lastSyncFor(customerId)?.context.isCoolingOff).toBe(true), WAIT);
    expect(
      readSupportChatCalls().syncs.filter((s) => s.context.userId === neverOpened.userId),
    ).toHaveLength(0);
  });

  it('converges on the latest state when an older sync lands after a newer one', async () => {
    const c = testApp.container;
    const service = new SupportChatService({
      drizzle: c.get(DRIZZLE),
      audit: c.get(AUDIT_WRITER),
      identityReader: c.get(IDENTITY_READER),
      walletReader: c.get(WALLET_READER),
      rgExclusionReader: c.get(RG_EXCLUSION_READER),
      provider: c.get(SUPPORT_CHAT_PROVIDER),
      scheduleSync: async () => {},
    });
    const p = await newPlayer();
    const customerId = await openSession(p.client);
    await waitForSyncs(customerId, 1);

    // Sync A reads the player while active; its vendor write is held back.
    const gate = holdNextSupportChatSync(customerId);
    const syncA = service.syncCustomer(p.userId);
    await gate.reached;

    // The player self-excludes and sync B writes it.
    const excluded = await admin.post(`/compliance/players/${p.userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'support-chat convergence e2e',
      confirm: true,
    });
    expect(excluded.status).toBe(200);
    await service.syncCustomer(p.userId);
    expect(lastSyncFor(customerId)?.context.isSelfExcluded).toBe(true);

    // A's stale write lands last.
    const before = syncsFor(customerId).length;
    gate.release();
    await syncA;
    const after = syncsFor(customerId).slice(before);
    expect(after.some(({ context }) => context.accountStatus === 'active')).toBe(true);
    expect(lastSyncFor(customerId)?.context).toMatchObject({
      accountStatus: 'self_excluded',
      isSelfExcluded: true,
    });
  });
});

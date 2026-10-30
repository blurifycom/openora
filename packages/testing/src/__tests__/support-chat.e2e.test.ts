import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { and, eq, like, sql } from 'drizzle-orm';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  JOB_QUEUE,
  PLAYER_ACCOUNT_MANAGER_READER,
  RG_EXCLUSION_READER,
  SUPPORT_CHAT_PROVIDER,
  SupportChatProviderError,
  SupportCustomerContextSchema,
  WAGER_TRACKING,
  WALLET_READER,
  queue,
} from '@openora/core/contracts';
import {
  DRIZZLE,
  EVENT_BUS,
  eventOutbox,
  loadExtensions,
  processedEvents,
  setErrorReporter,
} from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { rgExclusion } from '@openora/core/compliance/schema';
import { SupportChatService } from '@openora/core/engagement/server';
import { supportChatCustomer } from '@openora/core/engagement/schema/support-chat';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { promoPlayerRank } from '@openora/core/promo/schema/gamification';
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
  answerNextSupportChatTokenWith,
  failNextSupportChatToken,
  failSupportChatSyncs,
  holdNextSupportChatSync,
  malformNextSupportChatToken,
  readSupportChatCalls,
  resetSupportChat,
  setSupportChatSyncDelay,
  supportChatSyncAttempts,
} from '../test-support-chat-plugin.js';
import { EXAMPLE_RANK_LADDER } from '../seed.js';

const supportChatPluginPath = fileURLToPath(
  new URL('../test-support-chat-plugin.ts', import.meta.url),
);

const WAIT = { timeout: 15_000, interval: 50 };
const SESSION = '/support-chat/session';
const SYNC_QUEUE = 'support-chat.sync-customer';
const PASSWORD = 'password1234';
const CONTEXT_KEYS = [
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
let unconfiguredDb: TestDb;
let testApp: TestApp;
let unconfiguredApp: TestApp;
let admin: TestClient;

type Player = { client: TestClient; userId: string; playerId: string; email: string };
type LinkedPlayer = Player & { customerId: string };

async function newPlayer(app: TestApp = testApp): Promise<Player> {
  const email = `support-chat-${randomUUID()}@e2e.test`;
  return { ...(await registerAndMaterializePlayer(app, { email })), email };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const ok = async (res: Response) => {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
};

async function openSession(client: TestClient): Promise<string> {
  const res = await client.post(SESSION);
  expect(res.status).toBe(200);
  return String((await body(res))['customerId']);
}

const syncsFor = (customerId: string) =>
  readSupportChatCalls().syncs.filter((sync) => sync.customerId === customerId);

const lastSyncFor = (customerId: string) => syncsFor(customerId).at(-1);

async function waitForSyncs(customerId: string, count: number) {
  await vi.waitFor(() => expect(syncsFor(customerId).length).toBeGreaterThanOrEqual(count), WAIT);
}

async function newManager() {
  const manager = await newPlayer();
  const managerName = `Manager ${randomUUID()}`;
  await assignIamRoleByKey(testApp.container, manager.userId, 'vip-manager');
  await testApp.container
    .get(DRIZZLE)
    .db.update(user)
    .set({ name: managerName })
    .where(eq(user.id, manager.userId));
  return { manager, managerName };
}

/** Opens the chat and waits for the open's own sync, the only one it enqueues. */
async function linkedPlayer(): Promise<LinkedPlayer> {
  const p = await newPlayer();
  const customerId = await openSession(p.client);
  await waitForSyncs(customerId, 1);
  return { ...p, customerId };
}

/** Runs `trigger`, then waits for a newer sync whose context matches `expected`. */
async function refreshedBy(
  p: LinkedPlayer,
  trigger: () => Promise<void>,
  expected: Record<string, unknown>,
) {
  const before = syncsFor(p.customerId).length;
  await trigger();
  await vi.waitFor(() => {
    const landed = syncsFor(p.customerId);
    expect(landed.length).toBeGreaterThan(before);
    expect(landed.at(-1)?.context).toMatchObject(expected);
  }, WAIT);
  return lastSyncFor(p.customerId)?.context;
}

const linkRows = (playerId: string) =>
  testApp.container
    .get(DRIZZLE)
    .db.select()
    .from(supportChatCustomer)
    .where(eq(supportChatCustomer.playerId, playerId));

const enqueueSync = (userId: string) =>
  testApp.container.get(JOB_QUEUE).enqueue(queue(SYNC_QUEUE), { userId }, { attempts: 1 });

/** Links a player, then changes the database and syncs again. */
async function contextAfter(change: (p: Player) => Promise<void>) {
  const p = await linkedPlayer();
  await change(p);
  await enqueueSync(p.userId);
  await waitForSyncs(p.customerId, 2);
  return lastSyncFor(p.customerId)?.context;
}

const insertExclusion = (values: Omit<typeof rgExclusion.$inferInsert, 'reason' | 'createdBy'>) =>
  testApp.container
    .get(DRIZZLE)
    .db.insert(rgExclusion)
    .values({ reason: 'e2e', createdBy: randomUUID(), ...values })
    .then(() => undefined);

const HOUR_AGO = () => new Date(Date.now() - 3_600_000);

/** Waits until the support-chat subscriber finished handling `topic` for `userId`. */
async function waitForSupportChatHandled(app: TestApp, topic: string, userId: string) {
  const db_ = app.container.get(DRIZZLE).db;
  await vi.waitFor(async () => {
    const rows = await db_
      .select({ eventId: processedEvents.eventId })
      .from(processedEvents)
      .innerJoin(eventOutbox, eq(eventOutbox.eventId, processedEvents.eventId))
      .where(
        and(
          eq(eventOutbox.topic, topic),
          sql`${eventOutbox.payload}->>'userId' = ${userId}`,
          like(processedEvents.consumer, `%/support-chat/${topic}`),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
  }, WAIT);
}

/** Records every enqueue on `app`'s real job queue; the calls still go through. */
const watchEnqueues = (app: TestApp) => vi.spyOn(app.container.get(JOB_QUEUE), 'enqueue');

const syncJobsFor = (spy: ReturnType<typeof watchEnqueues>, userId: string) =>
  spy.mock.calls.filter(
    ([name, payload]) => String(name) === SYNC_QUEUE && JSON.stringify(payload).includes(userId),
  );

/** The options of every hourly resync enqueued for `userId`, refused or not. */
const resyncsFor = (spy: ReturnType<typeof watchEnqueues>, userId: string) =>
  syncJobsFor(spy, userId)
    .map(([, , opts]) => opts)
    .filter((opts) => opts?.idempotencyKey?.startsWith(`support-chat-resync:${userId}:`));

beforeAll(async () => {
  const extensions = await loadExtensions();
  ({ db, app: testApp } = await bootE2e({
    plugins: [...extensions, { id: 'testing-support-chat', path: supportChatPluginPath }],
  }));
  admin = await asAdmin(testApp.app);
  // Its own database: on a shared one its outbox relay would claim the other app's events.
  ({ db: unconfiguredDb, app: unconfiguredApp } = await bootE2e({
    plugins: extensions,
    seed: false,
  }));
  resetSupportChat();
}, 60_000);

afterEach(() => {
  setSupportChatSyncDelay(0);
  failSupportChatSyncs(false);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeE2e({ app: unconfiguredApp, db: unconfiguredDb });
  await closeE2e({ app: testApp, db });
});

describe('POST /support-chat/session', () => {
  it('links one vendor customer on first open, reuses it after, and syncs the support context', async () => {
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
    expect(requests.findIndex((r) => r.customerId === customerId)).toBeGreaterThan(
      requests.findIndex((r) => r.customerId === undefined),
    );
    expect(await linkRows(p.playerId)).toHaveLength(1);

    await waitForSyncs(customerId, 1);
    const context = lastSyncFor(customerId)?.context;
    const [{ username } = { username: '' }] = await testApp.container
      .get(DRIZZLE)
      .db.select({ username: user.username })
      .from(user)
      .where(eq(user.id, p.userId));
    const { activeCurrency } = await testApp.container.get(WALLET_READER).getBalances(p.userId);
    expect(username).not.toBe(p.email);
    expect(activeCurrency).toEqual(expect.any(String));
    expect(context).toMatchObject({
      playerId: p.playerId,
      userId: p.userId,
      email: p.email,
      username,
      accountStatus: 'active',
      isSelfExcluded: false,
      isCoolingOff: false,
      accountManagerName: null,
      activeCurrency,
    });
    expect(Math.abs(Date.now() - Date.parse(String(context?.syncedAt)))).toBeLessThan(60_000);
  });

  it('refuses a guest with 401', async () => {
    const res = await testApp.app.request(SESSION, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('gives an admin without a player profile a refusal', async () => {
    const res = await admin.post(SESSION);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('ignores a body naming another player and links nothing for that player', async () => {
    const victim = await newPlayer();
    const attacker = await newPlayer();
    const res = await attacker.client.post(SESSION, {
      userId: victim.userId,
      playerId: victim.playerId,
      customerId: 'customer-someone-else',
    });
    expect(res.status).toBe(200);
    const customerId = String((await body(res))['customerId']);
    await waitForSyncs(customerId, 1);
    expect(lastSyncFor(customerId)?.context).toMatchObject({ userId: attacker.userId });
    expect(await linkRows(victim.playerId)).toHaveLength(0);
    expect(await linkRows(attacker.playerId)).toEqual([
      expect.objectContaining({ providerCustomerId: customerId }),
    ]);
    expect(
      readSupportChatCalls().tokenRequests.some((r) => r.customerId === 'customer-someone-else'),
    ).toBe(false);
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

  it('keeps a raw adapter error and its vendor secret out of the response and the error reporter', async () => {
    const secret = `sk_live_${randomUUID()}`;
    const rawClientError = () =>
      Object.assign(new Error(`POST https://vendor.example/customers?key=${secret} failed`), {
        config: { headers: { Authorization: `Bearer ${secret}` } },
      });
    const reported: { error: unknown; context: unknown }[] = [];
    setErrorReporter((error, context) => reported.push({ error, context }));
    try {
      const p = await newPlayer();
      failNextSupportChatToken(rawClientError());
      const refused = await p.client.post(SESSION);
      expect(refused.status).toBe(503);
      expect(await refused.text()).not.toContain(secret);

      failSupportChatSyncs(rawClientError());
      await openSession(p.client);
      await enqueueSync(p.userId);
      const deadLetter = await vi.waitFor(() => {
        const found = reported.find(({ context }) => inspect(context).includes(SYNC_QUEUE));
        if (!found) {
          throw new Error('sync dead-letter not reported yet');
        }
        return found;
      }, WAIT);
      expect(deadLetter.error).toBeInstanceOf(SupportChatProviderError);
      expect((deadLetter.error as Error).cause).toBeUndefined();
      expect(inspect(reported, { depth: null })).not.toContain(secret);
    } finally {
      setErrorReporter(undefined);
    }
  });

  it("fails with 500, links nothing and leaks no database detail when the vendor hands out another player's customer", async () => {
    const owner = await linkedPlayer();
    const other = await newPlayer();
    answerNextSupportChatTokenWith(owner.customerId);
    const res = await other.client.post(SESSION);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ status: 500, message: 'Internal server error' });
    for (const leak of [
      'support_chat_customer',
      'duplicate',
      'insert',
      'link missing',
      'conflicting',
      owner.customerId,
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(await linkRows(other.playerId)).toHaveLength(0);
    expect(await linkRows(owner.playerId)).toEqual([
      expect.objectContaining({ providerCustomerId: owner.customerId }),
    ]);
  });

  it('returns before a slow vendor write and the write lands through the job', async () => {
    setSupportChatSyncDelay(1_000);
    const { client } = await newPlayer();
    const customerId = await openSession(client);
    expect(syncsFor(customerId)).toHaveLength(0);
    await waitForSyncs(customerId, 1);
  });

  it('answers 200 while the vendor write fails, and the job did attempt the write', async () => {
    failSupportChatSyncs(true);
    const { client } = await newPlayer();
    const customerId = await openSession(client);
    await vi.waitFor(() => expect(supportChatSyncAttempts(customerId)).toBeGreaterThan(0), WAIT);
    expect(syncsFor(customerId)).toHaveLength(0);
    // The failed write does not poison the next open.
    expect((await client.post(SESSION)).status).toBe(200);
  });

  it('reschedules a sync that ran out of retries for the next hour, one job per player', async () => {
    failSupportChatSyncs(true);
    const p = await newPlayer();
    await openSession(p.client);
    const enqueues = watchEnqueues(testApp);
    await enqueueSync(p.userId);
    await enqueueSync(p.userId);
    await vi.waitFor(() => expect(resyncsFor(enqueues, p.userId)).toHaveLength(2), WAIT);
    const [first, second] = resyncsFor(enqueues, p.userId);
    // Both give-ups share one key, so the queue holds a single resync for the player.
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(first?.attempts).toBe(1);
    expect(first?.delayMs).toBeGreaterThan(0);
    expect(first?.delayMs).toBeLessThanOrEqual(3_600_000);
  });

  it('reports a sync that ran out of retries to error tracking, naming the player only', async () => {
    const reported: { error: unknown; context: unknown }[] = [];
    setErrorReporter((error, context) => reported.push({ error, context }));
    try {
      failSupportChatSyncs(true);
      const p = await newPlayer();
      await openSession(p.client);
      const [{ username } = { username: '' }] = await testApp.container
        .get(DRIZZLE)
        .db.select({ username: user.username })
        .from(user)
        .where(eq(user.id, p.userId));
      await enqueueSync(p.userId);
      const gaveUp = await vi.waitFor(() => {
        const found = reported.find(({ context }) =>
          inspect(context).includes('support-chat sync gave up'),
        );
        if (!found) {
          throw new Error('sync give-up not reported yet');
        }
        return found;
      }, WAIT);
      expect(gaveUp.error).toBeInstanceOf(SupportChatProviderError);
      expect(gaveUp.context).toMatchObject({ extra: { userId: p.userId } });
      const sent = inspect(gaveUp, { depth: null });
      expect(sent).not.toContain(p.email);
      expect(sent).not.toContain(username);
    } finally {
      setErrorReporter(undefined);
    }
  });

  it('asks the queue again when it refuses to schedule the resync once', async () => {
    failSupportChatSyncs(true);
    const p = await newPlayer();
    await openSession(p.client);
    const jobQueue = testApp.container.get(JOB_QUEUE);
    const enqueue = jobQueue.enqueue.bind(jobQueue);
    let refused = 0;
    const enqueues = vi.spyOn(jobQueue, 'enqueue').mockImplementation((name, payload, options) => {
      if (options?.idempotencyKey?.startsWith(`support-chat-resync:${p.userId}:`) && !refused) {
        refused++;
        return Promise.reject(new Error('job queue down'));
      }
      return enqueue(name, payload, options);
    });
    await enqueueSync(p.userId);
    // The refused one and the one that went through.
    await vi.waitFor(() => expect(resyncsFor(enqueues, p.userId)).toHaveLength(2), WAIT);
    expect(refused).toBe(1);
  });

  it('keeps the first sync owed through a job queue outage on first open', async () => {
    const p = await newPlayer();
    const pg = testApp.container.get(DRIZZLE).db;
    const jobQueue = testApp.container.get(JOB_QUEUE);
    const enqueue = jobQueue.enqueue.bind(jobQueue);
    let refused = 0;
    vi.spyOn(jobQueue, 'enqueue').mockImplementation((name, payload, options) => {
      if (String(name) === SYNC_QUEUE && JSON.stringify(payload).includes(p.userId)) {
        refused++;
        return Promise.reject(new Error('job queue down'));
      }
      return enqueue(name, payload, options);
    });

    const customerId = await openSession(p.client);

    // The link and its event commit together, so the sync is owed even though no job exists.
    expect(await linkRows(p.playerId)).toHaveLength(1);
    const [linked] = await pg
      .select({ eventId: eventOutbox.eventId })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.topic, 'support_chat.customer.linked'),
          sql`${eventOutbox.payload}->>'userId' = ${p.userId}`,
        ),
      );
    expect(linked).toBeDefined();

    // The subscriber's enqueue failed and it threw, so the event is not marked handled and
    // the broker redelivers it once the queue is back.
    await vi.waitFor(() => expect(refused).toBe(1), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const handled = await pg
      .select({ eventId: processedEvents.eventId })
      .from(processedEvents)
      .where(
        and(
          eq(processedEvents.eventId, linked!.eventId),
          like(processedEvents.consumer, '%/support-chat/support_chat.customer.linked'),
        ),
      );
    expect(handled).toHaveLength(0);
    expect(syncsFor(customerId)).toHaveLength(0);
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

    // The same single entry is what an admin reads back; a player may not read it.
    const res = await admin.get(
      `/audit/logs?action=support_chat.customer.linked&actorId=${p.userId}`,
    );
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: Record<string, unknown>[] };
    expect(items).toEqual([
      expect.objectContaining({ actorType: 'player', actorId: p.userId, ip: '203.0.113.7' }),
    ]);
    expect((await p.client.get('/audit/logs?action=support_chat.customer.linked')).status).toBe(
      403,
    );
  });

  it('sends a funded player with a phone and date of birth only the twelve context keys', async () => {
    const p = await linkedPlayer();
    await ok(
      await p.client.post('/wallet/deposit', {
        idempotencyKey: randomUUID(),
        amount: '2',
        currency: 'USD',
      }),
    );
    await ok(
      await p.client.patch('/profile', {
        phone: '+48123456789',
        dateOfBirth: '1990-01-01',
        firstName: 'Secret',
        lastName: 'Person',
      }),
    );
    const context = await refreshedBy(
      p,
      async () =>
        ok(
          await admin.post(`/compliance/players/${p.userId}/cooling-off`, {
            durationHours: 24,
            reason: 'payload check',
          }),
        ),
      { isCoolingOff: true },
    );
    expect(Object.keys(context ?? {}).sort()).toEqual(CONTEXT_KEYS);
    expect(SupportCustomerContextSchema.safeParse(context).success).toBe(true);
    expect(SupportCustomerContextSchema.safeParse({ ...context, balance: 1 }).success).toBe(false);
    const everything = JSON.stringify(readSupportChatCalls());
    for (const secret of ['+48123456789', '1990-01-01', 'Secret', 'Person', 'balance']) {
      expect(everything).not.toContain(secret);
    }
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
      }),
    );
    expect(context).toMatchObject({ isSelfExcluded: false, accountStatus: 'active' });
  });

  it('does not bind an expired-status self-exclusion', async () => {
    const context = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'self_exclusion',
        status: 'expired',
        isPermanent: false,
        expiresAt: HOUR_AGO(),
      }),
    );
    expect(context).toMatchObject({ isSelfExcluded: false, accountStatus: 'active' });
  });

  it('keeps a fixed-term self-exclusion binding past its expiry until it is lifted', async () => {
    const context = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'self_exclusion',
        status: 'active',
        isPermanent: false,
        expiresAt: HOUR_AGO(),
      }),
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

  it('ends a cooling-off at its expiry before the sweep marks it', async () => {
    const context = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'cooling_off',
        status: 'active',
        expiresAt: HOUR_AGO(),
      }),
    );
    expect(context).toMatchObject({ isCoolingOff: false });
  });

  it('treats a lifted cooling-off with a future expiry as not cooling off and an active one as cooling off', async () => {
    const lifted = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'cooling_off',
        status: 'lifted',
        expiresAt: new Date(Date.now() + 3_600_000),
        liftedAt: new Date(),
      }),
    );
    expect(lifted).toMatchObject({ isCoolingOff: false });
    const active = await contextAfter((p) =>
      insertExclusion({
        userId: p.userId,
        kind: 'cooling_off',
        status: 'active',
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    );
    expect(active).toMatchObject({ isCoolingOff: true, isSelfExcluded: false });
  });
});

describe('support context refresh', () => {
  it('a self-service cooling-off refreshes the linked player and enqueues nothing for one who never opened the chat', async () => {
    const enqueues = watchEnqueues(testApp);
    const bystander = await newPlayer();
    const p = await linkedPlayer();
    await refreshedBy(
      p,
      async () => {
        await ok(await bystander.client.post('/compliance/rg/cooling-off', { durationHours: 24 }));
        await ok(await p.client.post('/compliance/rg/cooling-off', { durationHours: 24 }));
      },
      { isCoolingOff: true, accountStatus: 'active' },
    );
    await waitForSupportChatHandled(testApp, 'rg.cooling_off.activated', bystander.userId);
    expect(syncJobsFor(enqueues, bystander.userId)).toHaveLength(0);
  });

  it('the sweep expiring a lapsed cooling-off refreshes the linked player', async () => {
    const p = await linkedPlayer();
    await insertExclusion({
      userId: p.userId,
      kind: 'cooling_off',
      status: 'active',
      expiresAt: HOUR_AGO(),
    });
    await refreshedBy(
      p,
      async () => {
        await testApp.container.get(JOB_QUEUE).enqueue(queue('rg-monitor'), {});
        await waitForSupportChatHandled(testApp, 'rg.cooling_off.expired', p.userId);
      },
      { isCoolingOff: false },
    );
  });

  it('self-exclusion activates and an admin lift clears it', async () => {
    const p = await linkedPlayer();
    await refreshedBy(
      p,
      async () =>
        ok(
          await p.client.post('/compliance/rg/self-exclusion', {
            isPermanent: false,
            durationMonths: 6,
            confirm: true,
          }),
        ),
      { isSelfExcluded: true, accountStatus: 'self_excluded' },
    );
    // A fixed term can only be lifted once it has run out; it keeps binding until then.
    await testApp.container
      .get(DRIZZLE)
      .db.update(rgExclusion)
      .set({ expiresAt: HOUR_AGO() })
      .where(eq(rgExclusion.userId, p.userId));
    await refreshedBy(
      p,
      async () =>
        ok(
          await admin.post(`/compliance/players/${p.userId}/self-exclusion/lift`, {
            reason: 'e2e lift',
            confirm: true,
          }),
        ),
      { isSelfExcluded: false, accountStatus: 'active' },
    );
  });

  it('an admin cooling-off and its lift refresh the flag', async () => {
    const p = await linkedPlayer();
    await refreshedBy(
      p,
      async () =>
        ok(
          await admin.post(`/compliance/players/${p.userId}/cooling-off`, {
            durationHours: 24,
            reason: 'e2e',
          }),
        ),
      { isCoolingOff: true },
    );
    await refreshedBy(
      p,
      async () =>
        ok(await admin.post(`/compliance/players/${p.userId}/cooling-off/lift`, { reason: 'e2e' })),
      { isCoolingOff: false },
    );
  });

  it('status change, close and reopen refresh the account status; suspended outranks self-exclusion', async () => {
    const p = await linkedPlayer();
    const setStatus = (status: string) => async () =>
      ok(await admin.patch(`/players/${p.playerId}`, { status }));
    await refreshedBy(p, setStatus('suspended'), { accountStatus: 'suspended' });
    await refreshedBy(
      p,
      async () =>
        ok(
          await admin.post(`/compliance/players/${p.userId}/self-exclusion`, {
            isPermanent: true,
            reason: 'e2e',
            confirm: true,
          }),
        ),
      { isSelfExcluded: true, accountStatus: 'suspended' },
    );
    await refreshedBy(p, setStatus('closed'), { accountStatus: 'closed', isSelfExcluded: true });
    await refreshedBy(p, setStatus('active'), {
      accountStatus: 'self_excluded',
      isSelfExcluded: true,
    });
  });

  it('a KYC override refreshes the status, and a legacy verified status reads as approved', async () => {
    const p = await linkedPlayer();
    await refreshedBy(
      p,
      async () =>
        ok(
          await admin.post(`/compliance/players/${p.userId}/kyc/override`, {
            userId: p.userId,
            tier: 'basic',
            status: 'approved',
            reason: 'e2e',
          }),
        ),
      { kycStatus: 'manually_overridden' },
    );

    const legacy = await linkedPlayer();
    await testApp.container
      .get(DRIZZLE)
      .db.update(player)
      .set({ kycStatus: 'verified' })
      .where(eq(player.id, legacy.playerId));
    await refreshedBy(
      legacy,
      async () => ok(await legacy.client.post('/compliance/rg/cooling-off', { durationHours: 24 })),
      { kycStatus: 'approved' },
    );
  });

  it('an email change writes the new address', async () => {
    const p = await linkedPlayer();
    const newEmail = `support-chat-new-${randomUUID()}@e2e.test`;
    clearCapturedEmails();
    await ok(
      await p.client.post('/identity/email/change/request', {
        newEmail,
        currentPassword: PASSWORD,
      }),
    );
    const mail = await waitForEmail(
      newEmail,
      (m) => m.subject === 'Confirm your new email address',
    );
    const otp = /(\d{6})/.exec(mail.text)?.[1];
    await refreshedBy(
      p,
      async () => ok(await p.client.post('/identity/email/change/confirm', { newEmail, otp })),
      { email: newEmail },
    );
  });

  it('names the lowest tier for a player with no tier, and keeps a held tier', async () => {
    const lowest = EXAMPLE_RANK_LADDER.tiers[0]?.name;
    const noRow = await linkedPlayer();
    expect(lastSyncFor(noRow.customerId)?.context).toMatchObject({ rankName: lowest });

    const noTier = await contextAfter(async (p) => {
      await testApp.container
        .get(DRIZZLE)
        .db.insert(promoPlayerRank)
        .values({ userId: p.userId, currency: EXAMPLE_RANK_LADDER.currency, tierId: null });
    });
    expect(noTier).toMatchObject({ rankName: lowest });

    const held = await contextAfter(async (p) => {
      await testApp.container.get(DRIZZLE).db.transaction((tx) =>
        testApp.container.get(WAGER_TRACKING).recordWager(tx, {
          userId: p.userId,
          currency: 'USDT',
          amount: '10000',
          weightedAmount: '10000',
          realAmount: '10000',
          context: { provider: 'aggregator', product: 'casino' },
        }),
      );
    });
    expect(held).toMatchObject({ rankName: EXAMPLE_RANK_LADDER.tiers[1]?.name });
  });

  it('a rank change writes the new tier name', async () => {
    const p = await linkedPlayer();
    await refreshedBy(
      p,
      async () => {
        await testApp.container.get(DRIZZLE).db.transaction((tx) =>
          testApp.container.get(WAGER_TRACKING).recordWager(tx, {
            userId: p.userId,
            currency: 'USDT',
            amount: '10000',
            weightedAmount: '10000',
            realAmount: '10000',
            context: { provider: 'aggregator', product: 'casino' },
          }),
        );
        await testApp.container.get(JOB_QUEUE).enqueue(queue('promo-rank-announce'), {});
      },
      { rankName: expect.any(String) },
    );
  });

  it('an account manager change writes the manager name and a removal clears it', async () => {
    const p = await linkedPlayer();
    const { manager, managerName } = await newManager();
    const setManager = (accountManagerId: string | null) => async () =>
      ok(await admin.put(`/players/${p.playerId}/account-manager`, { accountManagerId }));

    const context = await refreshedBy(p, setManager(manager.userId), {
      accountManagerName: managerName,
    });
    expect(JSON.stringify(context)).not.toContain(manager.email);
    await refreshedBy(p, setManager(null), { accountManagerName: null });
  });

  it('never shows the player their account manager through the session route', async () => {
    const p = await linkedPlayer();
    const { manager, managerName } = await newManager();
    await ok(
      await admin.put(`/players/${p.playerId}/account-manager`, {
        accountManagerId: manager.userId,
      }),
    );

    const res = await p.client.post(SESSION);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      'accessToken',
      'customerId',
      'expiresInMs',
      'tokenType',
    ]);
    expect(text).not.toContain(managerName);
    expect(text).not.toContain(manager.userId);
  });

  it('with no provider and no linked player, handles an RG event without enqueuing a sync', async () => {
    const enqueues = watchEnqueues(unconfiguredApp);
    const p = await newPlayer(unconfiguredApp);
    await ok(await p.client.post('/compliance/rg/cooling-off', { durationHours: 24 }));
    await waitForSupportChatHandled(unconfiguredApp, 'rg.cooling_off.activated', p.userId);
    expect(syncJobsFor(enqueues, p.userId)).toHaveLength(0);
  });

  it('enqueues a sync for a linked player from a process without a provider', async () => {
    const p = await newPlayer(unconfiguredApp);
    // Linked by another process, one that has the provider bound.
    await unconfiguredApp.container
      .get(DRIZZLE)
      .db.insert(supportChatCustomer)
      .values({ playerId: p.playerId, providerCustomerId: `customer-${randomUUID()}` });
    const enqueues = watchEnqueues(unconfiguredApp);
    await ok(await p.client.post('/compliance/rg/cooling-off', { durationHours: 24 }));
    await waitForSupportChatHandled(unconfiguredApp, 'rg.cooling_off.activated', p.userId);
    expect(syncJobsFor(enqueues, p.userId)).toHaveLength(1);
  });

  it('fails and retries a sync job in a process without a provider, and still owes the hourly resync', async () => {
    const { userId } = await newPlayer(unconfiguredApp);
    const reported: { error: unknown; context: unknown }[] = [];
    setErrorReporter((error, context) => reported.push({ error, context }));
    const enqueues = watchEnqueues(unconfiguredApp);
    try {
      await unconfiguredApp.container
        .get(JOB_QUEUE)
        .enqueue(
          queue(SYNC_QUEUE),
          { userId },
          { attempts: 2, backoff: { type: 'fixed', delayMs: 10 } },
        );
      // Dead-lettered on its second attempt: both attempts failed, none completed it.
      const deadLetter = await vi.waitFor(() => {
        const found = reported.find(
          ({ context }) =>
            inspect(context).includes(SYNC_QUEUE) && inspect(context).includes('attempt: 2'),
        );
        if (!found) {
          throw new Error('sync dead-letter not reported yet');
        }
        return found;
      }, WAIT);
      expect((deadLetter.error as Error).message).toContain('SUPPORT_CHAT_PROVIDER');
      // Another process may have the provider, so the give-up still owes the hourly resync.
      await vi.waitFor(() => expect(resyncsFor(enqueues, userId)).toHaveLength(1), WAIT);
    } finally {
      setErrorReporter(undefined);
    }
  });

  it('converges on the latest state when an older sync lands after a newer one', async () => {
    const c = testApp.container;
    const service = new SupportChatService({
      drizzle: c.get(DRIZZLE),
      audit: c.get(AUDIT_WRITER),
      events: c.get(EVENT_BUS),
      identityReader: c.get(IDENTITY_READER),
      walletReader: c.get(WALLET_READER),
      rgExclusionReader: c.get(RG_EXCLUSION_READER),
      accountManagerReader: c.get(PLAYER_ACCOUNT_MANAGER_READER),
      provider: c.get(SUPPORT_CHAT_PROVIDER),
      scheduleSync: async () => {},
    });
    const p = await linkedPlayer();

    // Sync A reads the player while active; its vendor write is held back.
    const gate = holdNextSupportChatSync(p.customerId);
    const syncA = service.syncCustomer(p.userId);
    await gate.reached;

    // The player self-excludes and sync B writes it.
    await ok(
      await admin.post(`/compliance/players/${p.userId}/self-exclusion`, {
        isPermanent: true,
        reason: 'support-chat convergence e2e',
        confirm: true,
      }),
    );
    await service.syncCustomer(p.userId);
    expect(lastSyncFor(p.customerId)?.context.isSelfExcluded).toBe(true);

    // A's stale write lands last, then A re-reads and writes the newer state.
    const before = syncsFor(p.customerId).length;
    gate.release();
    await syncA;
    const after = syncsFor(p.customerId).slice(before);
    expect(after.some(({ context }) => context.accountStatus === 'active')).toBe(true);
    expect(lastSyncFor(p.customerId)?.context).toMatchObject({
      accountStatus: 'self_excluded',
      isSelfExcluded: true,
    });
  });
});

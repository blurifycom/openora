import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { JOB_QUEUE, WAGER_TRACKING, queue } from '@openora/core/contracts';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { supportChatCustomer } from '@openora/core/engagement/schema/support-chat';
import { rgExclusion } from '@openora/core/compliance/schema';
import { player } from '@openora/core/pam/schema/profile';
import {
  asAdmin,
  bootTestApp,
  clearCapturedEmails,
  registerAndMaterializePlayer,
  seedMinimal,
  setupTestDb,
  waitForEmail,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import {
  answerNextSupportChatTokenWith,
  readSupportChatCalls,
  resetSupportChat,
} from '../test-support-chat-plugin.js';
import { failedSupportChatSyncAttempts } from './fixtures/test-throwing-support-chat-sync-plugin.js';

const doublePath = fileURLToPath(new URL('../test-support-chat-plugin.ts', import.meta.url));
const throwingPath = fileURLToPath(
  new URL('./fixtures/test-throwing-support-chat-sync-plugin.ts', import.meta.url),
);

const WAIT = { timeout: 15_000, interval: 50 };
const SESSION = '/support-chat/session';
const PASSWORD = 'password1234';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let throwingDb: TestDb;
let throwingApp: TestApp;
let unconfiguredDb: TestDb;
let unconfiguredApp: TestApp;

type Player = { client: TestClient; userId: string; playerId: string; email: string };

async function newPlayer(target: TestApp = app): Promise<Player> {
  const email = `support-refresh-${randomUUID()}@e2e.test`;
  return { ...(await registerAndMaterializePlayer(target, { email })), email };
}

const syncsFor = (customerId: string) =>
  readSupportChatCalls().syncs.filter((sync) => sync.customerId === customerId);

/** Opens the chat, then waits until the open's own sync has landed and nothing else is pending. */
async function linkedPlayer() {
  const p = await newPlayer();
  const res = await p.client.post(SESSION);
  expect(res.status).toBe(200);
  const { customerId } = (await res.json()) as { customerId: string };
  await vi.waitFor(() => expect(syncsFor(customerId).length).toBeGreaterThanOrEqual(1), WAIT);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { ...p, customerId };
}

/** Runs `trigger`, then waits for a sync whose context satisfies `expected` to land. */
async function refreshedBy(
  p: { customerId: string },
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
  return syncsFor(p.customerId).at(-1)?.context;
}

const ok = async (res: Response) => {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
};

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';
  const extensions = await loadExtensions();
  // Each app has its own database: on a shared one an outbox relay claims the other app's events.
  db = await setupTestDb();
  app = await bootTestApp({
    plugins: [...extensions, { id: 'testing-support-chat', path: doublePath }],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
  throwingDb = await setupTestDb();
  throwingApp = await bootTestApp({
    plugins: [...extensions, { id: 'test-throwing-support-chat-sync', path: throwingPath }],
    databaseUrl: throwingDb.url,
  });
  unconfiguredDb = await setupTestDb();
  unconfiguredApp = await bootTestApp({ plugins: extensions, databaseUrl: unconfiguredDb.url });
  await seedMinimal(unconfiguredApp.container, { playerCount: 0 });
  resetSupportChat();
}, 90_000);

afterAll(async () => {
  await throwingApp?.close();
  await unconfiguredApp?.close();
  await app?.close();
  await throwingDb?.dispose();
  await unconfiguredDb?.dispose();
  await db?.dispose();
});

describe('what the player and the request body can steer', () => {
  it('ignores a body naming another player and links nothing for that player', async () => {
    const victim = await newPlayer();
    const attacker = await newPlayer();
    const res = await attacker.client.post(SESSION, {
      userId: victim.userId,
      playerId: victim.playerId,
      customerId: 'customer-someone-else',
    });
    expect(res.status).toBe(200);
    const { customerId } = (await res.json()) as { customerId: string };
    await vi.waitFor(() => expect(syncsFor(customerId).length).toBeGreaterThan(0), WAIT);
    expect(syncsFor(customerId).at(-1)?.context).toMatchObject({ userId: attacker.userId });

    const db_ = app.container.get(DRIZZLE).db;
    expect(
      await db_
        .select()
        .from(supportChatCustomer)
        .where(eq(supportChatCustomer.playerId, victim.playerId)),
    ).toHaveLength(0);
    expect(
      await db_
        .select()
        .from(supportChatCustomer)
        .where(eq(supportChatCustomer.playerId, attacker.playerId)),
    ).toEqual([expect.objectContaining({ providerCustomerId: customerId })]);
    expect(
      readSupportChatCalls().tokenRequests.some((r) => r.customerId === 'customer-someone-else'),
    ).toBe(false);
  });

  it('records the first link in the audit log an admin reads, once after two opens', async () => {
    const p = await newPlayer();
    const open = () =>
      p.client.request(SESSION, {
        method: 'POST',
        headers: { 'x-real-ip': '203.0.113.9', 'user-agent': 'support-chat-audit-e2e' },
      });
    await ok(await open());
    await ok(await open());
    const res = await admin.get(
      `/audit/logs?action=support_chat.customer.linked&actorId=${p.userId}`,
    );
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: Record<string, unknown>[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      actorType: 'player',
      actorId: p.userId,
      action: 'support_chat.customer.linked',
    });
    expect(items[0]?.['ip']).toBe('203.0.113.9');
    expect(items[0]?.['userAgent']).toBe('support-chat-audit-e2e');
    expect(items[0]?.['after']).toEqual({
      providerCustomerId: expect.stringMatching(/^customer-/),
    });
  });

  it("keeps the database error out of the body when the vendor reuses another player's customer", async () => {
    const owner = await linkedPlayer();
    const other = await newPlayer();
    answerNextSupportChatTokenWith(owner.customerId);
    const res = await other.client.post(SESSION);
    expect(res.status).toBe(500);
    const text = await res.text();
    for (const leak of ['support_chat_customer', 'duplicate', 'insert', owner.customerId]) {
      expect(text).not.toContain(leak);
    }
  });

  it('is refused for a player on the admin audit route', async () => {
    const p = await newPlayer();
    expect((await p.client.get('/audit/logs?action=support_chat.customer.linked')).status).toBe(
      403,
    );
  });
});

describe('what leaves the platform', () => {
  it('sends a funded player with a phone and date of birth only the eleven context keys', async () => {
    const p = await linkedPlayer();
    await ok(
      await p.client.post('/wallet/deposit', {
        idempotencyKey: randomUUID(),
        amount: '2',
        currency: 'USD',
      }),
    );
    const profile = await p.client.get('/profile');
    await ok(profile);
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
      async () => {
        await ok(
          await admin.post(`/compliance/players/${p.userId}/cooling-off`, {
            durationHours: 24,
            reason: 'payload check',
          }),
        );
      },
      { isCoolingOff: true },
    );
    expect(Object.keys(context ?? {}).sort()).toEqual([
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
    ]);
    const everything = JSON.stringify(readSupportChatCalls());
    for (const secret of ['+48123456789', '1990-01-01', 'Secret', 'Person', 'balance']) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('support context follows the player on every public trigger', () => {
  it('a player cooling-off through the self-service route refreshes only the linked player', async () => {
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
    expect(
      readSupportChatCalls().syncs.filter((s) => s.context.userId === bystander.userId),
    ).toHaveLength(0);
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
    await app.container
      .get(DRIZZLE)
      .db.update(rgExclusion)
      .set({ expiresAt: new Date(Date.now() - 3_600_000) })
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

  it('an admin cooling-off lift clears the flag', async () => {
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
    await app.container
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
    const newEmail = `support-refresh-new-${randomUUID()}@e2e.test`;
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

  it('a profile update triggers a refresh', async () => {
    const p = await linkedPlayer();
    const before = syncsFor(p.customerId).length;
    await ok(await p.client.patch('/identity/profile', { theme: 'dark' }));
    await vi.waitFor(() => expect(syncsFor(p.customerId).length).toBeGreaterThan(before), WAIT);
  });

  it('a rank change writes the new tier name', async () => {
    const p = await linkedPlayer();
    await refreshedBy(
      p,
      async () => {
        await app.container.get(DRIZZLE).db.transaction((tx) =>
          app.container.get(WAGER_TRACKING).recordWager(tx, {
            userId: p.userId,
            currency: 'USDT',
            amount: '10000',
            weightedAmount: '10000',
            realAmount: '10000',
            context: { provider: 'aggregator', product: 'casino' },
          }),
        );
        await app.container.get(JOB_QUEUE).enqueue(queue('promo-rank-announce'), {});
      },
      { rankName: expect.any(String) },
    );
  });
});

describe('without a bound provider, and with a failing vendor write', () => {
  it('a cooling-off for a player in an unconfigured app is a quiet no-op and the route stays 503', async () => {
    const p = await newPlayer(unconfiguredApp);
    expect((await p.client.post(SESSION)).status).toBe(503);
    const unconfiguredAdmin = await asAdmin(unconfiguredApp.app);
    await ok(
      await unconfiguredAdmin.post(`/compliance/players/${p.userId}/cooling-off`, {
        durationHours: 24,
        reason: 'no provider',
      }),
    );
    const rows = await unconfiguredApp.container.get(DRIZZLE).db.select().from(supportChatCustomer);
    expect(rows).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await (await newPlayer(unconfiguredApp)).client.post(SESSION)).status).toBe(503);
  });

  it('answers 200 while the vendor write fails, and the job did attempt the write', async () => {
    const p = await newPlayer(throwingApp);
    const res = await p.client.post(SESSION);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ customerId: expect.any(String) });
    await vi.waitFor(() => expect(failedSupportChatSyncAttempts()).toBeGreaterThanOrEqual(1), WAIT);
    // The failed write does not poison the next open.
    expect((await p.client.post(SESSION)).status).toBe(200);
  });
});

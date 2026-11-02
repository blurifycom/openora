import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { MESSAGE_BROKER } from '@openora/core/contracts';
import { DRIZZLE, eventOutbox, processedEvents } from '@openora/core/server';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { userLimit } from '@openora/core/compliance/schema';
import { player as playerProfile } from '@openora/core/pam/schema/profile';
import {
  registerAndMaterializePlayer,
  asAdmin,
  type TestApp,
  type TestDb,
  type TestClient,
  bootE2e,
  closeE2e,
  readJson,
} from '../index.js';

/**
 * The admin limit-override flow end to end: the `rg.limit.set` event now carries the old
 * limit's own currency, and the player's in-app `rg.limit.admin_updated` notification
 * and the audit row show it. Driven over the real app and a real Postgres db; the only
 * rows written behind the app are the exchange-rate quotes (no provider is wired in
 * tests) and a legacy NULL-currency limit row (the API can no longer create one).
 */

let db: TestDb;
let app: TestApp;
let admin: TestClient;

type Params = Record<string, string> | null;

async function notificationParams(client: TestClient): Promise<Params[]> {
  const res = await client.get('/notifications');
  expect(res.status).toBe(200);
  const body = (await readJson(res)) as {
    items: Array<{ type: string; params: Params }>;
  };
  return body.items.filter((n) => n.type === 'rg.limit.admin_updated').map((n) => n.params);
}

function setLimit(userId: string, body: Record<string, unknown>) {
  return admin.put(`/compliance/players/${userId}/limits`, {
    minutes: null,
    amount: null,
    currency: null,
    period: 'daily',
    reason: 'internal: support ticket 4411',
    confirm: true,
    ...body,
  });
}

async function setPlayerCurrency(userId: string, currency: string) {
  await app.container
    .get(DRIZZLE)
    .db.update(playerProfile)
    .set({ currency })
    .where(eq(playerProfile.userId, userId));
}

async function auditAfter(playerId: string) {
  const res = await admin.get(`/audit/logs?resourceId=${playerId}&action=rg.limit.set`);
  const body = (await readJson(res)) as { items: Array<{ after: Record<string, unknown> }> };
  return body.items.map((i) => i.after);
}

async function limitSetEvents(userId: string) {
  return app.container
    .get(DRIZZLE)
    .db.select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.topic, 'rg.limit.set'),
        sql`${eventOutbox.payload}->>'userId' = ${userId}`,
      ),
    );
}

const handled = async (eventId: string) =>
  (
    await app.container
      .get(DRIZZLE)
      .db.select({ consumer: processedEvents.consumer })
      .from(processedEvents)
      .where(eq(processedEvents.eventId, eventId))
  ).length;

beforeAll(async () => {
  ({ db, app } = await bootE2e());
  admin = await asAdmin(app.app);
  // Pivot is USD. 1 BTC = 100000 USD, 1 EUR = 1.1 USD, USDT = 1 USD.
  const providerAsOf = new Date();
  await app.container
    .get(DRIZZLE)
    .db.insert(exchangeRateQuote)
    .values([
      { baseCurrency: 'USDT', quoteCurrency: 'USD', rate: '1', providerAsOf },
      { baseCurrency: 'BTC', quoteCurrency: 'USD', rate: '100000', providerAsOf },
      { baseCurrency: 'EUR', quoteCurrency: 'USD', rate: '1.1', providerAsOf },
    ]);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('admin limit override carries the old limit currency', () => {
  it('shows 1000 USDT -> 0.005 BTC with both currencies, in the notification and the audit row', async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-cross-${randomUUID()}@e2e.test`,
    });
    expect(
      (await setLimit(p.userId, { type: 'deposit', amount: '1000', currency: 'USDT' })).status,
    ).toBe(200);

    const lower = await setLimit(p.userId, { type: 'deposit', amount: '0.005', currency: 'BTC' });
    expect(lower.status).toBe(200);

    await vi.waitFor(async () => {
      const found = (await notificationParams(p.client)).find((n) => n?.['currency'] === 'BTC');
      expect(found).toEqual({
        period: 'daily',
        limitType: 'deposit',
        previousAmount: '1000.000000000000000000',
        previousCurrency: 'USDT',
        amount: '0.005',
        currency: 'BTC',
      });
    });
    const after = (await auditAfter(p.playerId)).find((a) => a['currency'] === 'BTC');
    expect(after).toMatchObject({ previousCurrency: 'USDT', currency: 'BTC' });
    // The internal reason never reaches the player.
    expect(JSON.stringify(await notificationParams(p.client))).not.toContain('4411');
  });

  it("reports a legacy NULL-currency row in the player's currency, not the new limit's", async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-legacy-${randomUUID()}@e2e.test`,
    });
    await setPlayerCurrency(p.userId, 'EUR');
    await app.container.get(DRIZZLE).db.insert(userLimit).values({
      userId: p.userId,
      type: 'deposit',
      period: 'daily',
      amount: '100',
      minutes: null,
      currency: null,
    });

    // 100 EUR = 110 USD, so 50 USD is a lowering. Player currency (EUR) is neither side's new one.
    const res = await setLimit(p.userId, { type: 'deposit', amount: '50', currency: 'USD' });
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const found = (await notificationParams(p.client)).find((n) => n?.['currency'] === 'USD');
      expect(found).toMatchObject({ previousCurrency: 'EUR', currency: 'USD' });
    });
    expect((await auditAfter(p.playerId))[0]).toMatchObject({
      previousCurrency: 'EUR',
      currency: 'USD',
    });
  });

  it('gives a session limit minutes only, and refuses an admin raise without notifying', async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-sess-${randomUUID()}@e2e.test`,
    });
    const session = { type: 'session', period: 'session' };
    expect((await setLimit(p.userId, { ...session, minutes: 90 })).status).toBe(200);
    expect((await setLimit(p.userId, { ...session, minutes: 60 })).status).toBe(200);

    await vi.waitFor(async () => {
      const found = (await notificationParams(p.client)).find((n) => n?.['minutes'] === '60');
      expect(found).toEqual({
        period: 'session',
        limitType: 'session',
        previousMinutes: '90',
        minutes: '60',
      });
    });
    const after = (await auditAfter(p.playerId)).find((a) => a['minutes'] === 60);
    expect(after).toMatchObject({ previousCurrency: null, currency: null });

    const raise = await setLimit(p.userId, { ...session, minutes: 120 });
    expect(raise.status).toBeGreaterThanOrEqual(400);
    expect(raise.status).toBeLessThan(500);
    expect(await notificationParams(p.client)).toHaveLength(2);
  });

  it('omits previous amount and currency on a first-ever limit', async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-first-${randomUUID()}@e2e.test`,
    });
    expect(
      (await setLimit(p.userId, { type: 'deposit', amount: '50', currency: 'USD' })).status,
    ).toBe(200);

    await vi.waitFor(async () => {
      expect(await notificationParams(p.client)).toEqual([
        { period: 'daily', limitType: 'deposit', amount: '50', currency: 'USD' },
      ]);
    });
    expect((await auditAfter(p.playerId))[0]).toMatchObject({ previousCurrency: null });
  });

  it('keeps the notification private and the route admin-only', async () => {
    const owner = await registerAndMaterializePlayer(app, {
      email: `rgpc-own-${randomUUID()}@e2e.test`,
    });
    const other = await registerAndMaterializePlayer(app, {
      email: `rgpc-oth-${randomUUID()}@e2e.test`,
    });
    await setLimit(owner.userId, { type: 'deposit', amount: '80', currency: 'USD' });
    await vi.waitFor(async () => expect(await notificationParams(owner.client)).toHaveLength(1));

    expect(await notificationParams(other.client)).toEqual([]);
    expect((await app.app.request('/notifications')).status).toBe(401);
    const asPlayerCall = await other.client.put(`/compliance/players/${owner.userId}/limits`, {
      type: 'deposit',
      amount: '1',
      minutes: null,
      currency: 'USD',
      period: 'daily',
      reason: 'x',
      confirm: true,
    });
    expect(asPlayerCall.status).toBe(403);
    expect((await auditAfter(owner.playerId)).length).toBe(1);
  });

  it('notifies once when the broker redelivers the event', async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-redo-${randomUUID()}@e2e.test`,
    });
    await setLimit(p.userId, { type: 'deposit', amount: '60', currency: 'USD' });
    await vi.waitFor(async () => expect(await notificationParams(p.client)).toHaveLength(1));
    const [evt] = await limitSetEvents(p.userId);
    await vi.waitFor(async () => expect(await handled(evt!.eventId)).toBeGreaterThan(0));

    await app.container.get(MESSAGE_BROKER).publish({
      eventId: evt!.eventId,
      topic: evt!.topic,
      payload: evt!.payload,
      occurredAt: evt!.occurredAt.toISOString(),
      schemaVersion: evt!.schemaVersion,
    });
    // A later event is handled after the redelivery (same queue), so the redelivery has been seen.
    await setLimit(p.userId, { type: 'deposit', amount: '55', currency: 'USD' });
    await vi.waitFor(async () => expect(await notificationParams(p.client)).toHaveLength(2));

    expect(await notificationParams(p.client)).toHaveLength(2);
    expect((await auditAfter(p.playerId)).length).toBe(2);
  });

  it('drops a notification whose event carries a malformed previousCurrency, without breaking later ones', async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-bad-${randomUUID()}@e2e.test`,
    });
    await setLimit(p.userId, { type: 'deposit', amount: '60', currency: 'USD' });
    await vi.waitFor(async () => expect(await notificationParams(p.client)).toHaveLength(1));
    const [evt] = await limitSetEvents(p.userId);

    const forgedId = randomUUID();
    await app.container.get(MESSAGE_BROKER).publish({
      eventId: forgedId,
      topic: evt!.topic,
      payload: { ...(evt!.payload as object), amount: '777', previousCurrency: 'US$<script>' },
      occurredAt: new Date().toISOString(),
      schemaVersion: evt!.schemaVersion,
    });
    await new Promise((r) => setTimeout(r, 1500));

    expect((await notificationParams(p.client)).some((n) => n?.['amount'] === '777')).toBe(false);
    // The pipeline is still alive for the next real change.
    await setLimit(p.userId, { type: 'deposit', amount: '40', currency: 'USD' });
    await vi.waitFor(async () =>
      expect((await notificationParams(p.client)).some((n) => n?.['amount'] === '40')).toBe(true),
    );
  });
});

describe('player self-service limit change', () => {
  it('creates no notification and still audits the old currency', async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-self-${randomUUID()}@e2e.test`,
    });
    const body = (amount: string) => ({
      type: 'deposit',
      amount,
      minutes: null,
      currency: 'USD',
      period: 'daily',
    });
    expect((await p.client.put('/compliance/limits', body('100'))).status).toBe(200);
    expect((await p.client.put('/compliance/limits', body('50'))).status).toBe(200);

    await vi.waitFor(async () => {
      const after = (await auditAfter(p.playerId)).find(
        (a) => a['amount'] === '50.000000000000000000',
      );
      expect(after).toMatchObject({
        previousCurrency: 'USD',
        currency: 'USD',
        initiatedBy: 'player',
      });
    });
    expect(await notificationParams(p.client)).toEqual([]);
  });

  it('audits the old currency when a parked cross-currency raise is confirmed, with no notification', async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-park-${randomUUID()}@e2e.test`,
    });
    const put = (amount: string, currency: string) =>
      p.client.put('/compliance/limits', {
        type: 'deposit',
        amount,
        minutes: null,
        currency,
        period: 'daily',
      });
    expect((await put('100', 'USD')).status).toBe(200);
    // 0.01 BTC = 1000 USD: a raise, so it parks behind the cool-down instead of applying.
    expect((await put('0.01', 'BTC')).status).toBe(200);
    const db_ = app.container.get(DRIZZLE).db;
    const [row] = await db_.select().from(userLimit).where(eq(userLimit.userId, p.userId));
    await db_
      .update(userLimit)
      .set({
        pendingEffectiveAt: new Date(Date.now() - 3_600_000),
        pendingExpiresAt: new Date(Date.now() + 86_400_000),
      })
      .where(eq(userLimit.id, row!.id));

    const confirm = await p.client.post(`/compliance/limits/${row!.id}/pending/confirm`, {});
    expect(confirm.status).toBe(200);

    await vi.waitFor(async () => {
      const after = (await auditAfter(p.playerId)).find((a) => a['currency'] === 'BTC');
      expect(after).toMatchObject({
        previousCurrency: 'USD',
        currency: 'BTC',
        initiatedBy: 'player',
        reason: null,
      });
    });
    expect(await notificationParams(p.client)).toEqual([]);
  });
});

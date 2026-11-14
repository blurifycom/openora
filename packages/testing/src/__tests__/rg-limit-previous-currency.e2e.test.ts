import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { MESSAGE_BROKER } from '@openora/core/contracts';
import { DRIZZLE, eventOutbox } from '@openora/core/server';
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
 * tests) and a legacy NULL-currency limit row (the API can no longer create one), which the
 * compliance migration that pins legacy currencies then pins.
 */

const PIN_LEGACY_CURRENCY = new URL(
  '../../../core/src/compliance/drizzle/migrations/0017_pin_legacy_limit_currency.sql',
  import.meta.url,
);

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

/**
 * Proves the player's own change created no notification. An admin change in another slot
 * is the barrier: it is the same `rg.limit.set` stream and consumer group, published after
 * the player's event, so once its notification shows the player's event was handled too.
 */
async function expectNoPlayerChangeNotification(p: { userId: string; client: TestClient }) {
  expect((await setLimit(p.userId, { type: 'wager', amount: '30', currency: 'USD' })).status).toBe(
    200,
  );
  await vi.waitFor(async () => {
    expect((await notificationParams(p.client)).some((n) => n?.['limitType'] === 'wager')).toBe(
      true,
    );
  });
  expect(await notificationParams(p.client)).toEqual([
    { period: 'daily', limitType: 'wager', amount: '30', currency: 'USD' },
  ]);
}

function setLimit(userId: string, body: Record<string, unknown>) {
  return admin.put(`/compliance/players/${userId}/limits`, {
    minutes: null,
    amount: null,
    currency: null,
    period: 'daily',
    reason: 'internal-only-reason-marker',
    confirm: true,
    ...body,
  });
}

type AuditRow = { before: Record<string, unknown> | null; after: Record<string, unknown> };

async function auditRows(playerId: string, action = 'rg.limit.set'): Promise<AuditRow[]> {
  const res = await admin.get(`/audit/logs?resourceId=${playerId}&action=${action}`);
  return ((await readJson(res)) as { items: AuditRow[] }).items;
}

async function auditAfter(playerId: string) {
  return (await auditRows(playerId)).map((i) => i.after);
}

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
    await vi.waitFor(async () => {
      const row = (await auditRows(p.playerId)).find((r) => r.after['currency'] === 'BTC');
      expect(row?.after).toMatchObject({ previousCurrency: 'USDT', currency: 'BTC' });
      expect(row?.before?.['currency']).toBe('USDT');
    });
    // The internal reason never reaches the player.
    expect(JSON.stringify(await notificationParams(p.client))).not.toContain(
      'internal-only-reason-marker',
    );
  });

  it("reports a legacy NULL-currency row in the player's currency, not the new limit's", async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-legacy-${randomUUID()}@e2e.test`,
    });
    await app.container
      .get(DRIZZLE)
      .db.update(playerProfile)
      .set({ currency: 'EUR' })
      .where(eq(playerProfile.userId, p.userId));
    await app.container.get(DRIZZLE).db.insert(userLimit).values({
      userId: p.userId,
      type: 'deposit',
      period: 'daily',
      amount: '100',
      minutes: null,
      currency: null,
    });
    await app.container.get(DRIZZLE).db.execute(sql.raw(readFileSync(PIN_LEGACY_CURRENCY, 'utf8')));

    // 100 EUR = 110 USD, so 50 USD is a lowering. Player currency (EUR) is neither side's new one.
    const res = await setLimit(p.userId, { type: 'deposit', amount: '50', currency: 'USD' });
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const found = (await notificationParams(p.client)).find((n) => n?.['currency'] === 'USD');
      expect(found).toMatchObject({ previousCurrency: 'EUR', currency: 'USD' });
    });
    await vi.waitFor(async () => {
      expect((await auditAfter(p.playerId))[0]).toMatchObject({
        previousCurrency: 'EUR',
        currency: 'USD',
      });
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
    await vi.waitFor(async () => {
      const after = (await auditAfter(p.playerId)).find((a) => a['minutes'] === 60);
      expect(after).toMatchObject({ previousCurrency: null, currency: null });
    });
    const lowering = (await auditRows(p.playerId)).find((r) => r.after['minutes'] === 60);
    expect(lowering?.before).toMatchObject({ currency: null });

    const raise = await setLimit(p.userId, { ...session, minutes: 120 });
    expect(raise.status).toBe(409);
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
    await vi.waitFor(async () => {
      expect((await auditAfter(p.playerId))[0]).toMatchObject({ previousCurrency: null });
    });
    const [first] = await auditRows(p.playerId);
    expect(first?.before).toMatchObject({ currency: null });
  });

  it('drops a notification whose event carries a malformed previousCurrency, without breaking later ones', async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-bad-${randomUUID()}@e2e.test`,
    });
    await setLimit(p.userId, { type: 'deposit', amount: '60', currency: 'USD' });
    await vi.waitFor(async () => expect(await notificationParams(p.client)).toHaveLength(1));
    const [evt] = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.topic, 'rg.limit.set'),
          sql`${eventOutbox.payload}->>'userId' = ${p.userId}`,
        ),
      );

    const forgedId = randomUUID();
    await app.container.get(MESSAGE_BROKER).publish({
      eventId: forgedId,
      topic: evt!.topic,
      payload: { ...(evt!.payload as object), amount: '777', previousCurrency: 'US$<script>' },
      occurredAt: new Date().toISOString(),
      schemaVersion: evt!.schemaVersion,
    });
    // A real change on the same stream lands after the forged one, so once it shows the
    // forged event has been handled: the pipeline is alive and dropped the malformed one.
    await setLimit(p.userId, { type: 'deposit', amount: '40', currency: 'USD' });
    await vi.waitFor(async () =>
      expect((await notificationParams(p.client)).some((n) => n?.['amount'] === '40')).toBe(true),
    );
    expect((await notificationParams(p.client)).some((n) => n?.['amount'] === '777')).toBe(false);
  });
});

describe('player self-service limit change', () => {
  it('creates no notification and audits the old currency on a cross-currency lowering', async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-self-${randomUUID()}@e2e.test`,
    });
    const body = (amount: string, currency: string) => ({
      type: 'deposit',
      amount,
      minutes: null,
      currency,
      period: 'daily',
    });
    expect((await p.client.put('/compliance/limits', body('100', 'USD'))).status).toBe(200);
    // 50 EUR = 55 USD: a lowering, so it applies at once.
    expect((await p.client.put('/compliance/limits', body('50', 'EUR'))).status).toBe(200);

    await vi.waitFor(async () => {
      const after = (await auditAfter(p.playerId)).find(
        (a) => a['amount'] === '50.000000000000000000',
      );
      expect(after).toMatchObject({
        previousCurrency: 'USD',
        currency: 'EUR',
        initiatedBy: 'player',
      });
    });
    await expectNoPlayerChangeNotification(p);
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
    // change_confirmed carries no currency, so its before-snapshot must not claim one.
    await vi.waitFor(async () => {
      const [confirmed] = await auditRows(p.playerId, 'rg.limit.change_confirmed');
      expect(confirmed?.before).toBeTruthy();
      expect(confirmed?.before).not.toHaveProperty('currency');
    });
    await expectNoPlayerChangeNotification(p);
  });
});

describe('a limit 0017 left without a currency', () => {
  it('refuses the player with 409 and lets an admin lower it, reduce-only, into a currency', async () => {
    const p = await registerAndMaterializePlayer(app, {
      email: `rgpc-unpinned-${randomUUID()}@e2e.test`,
    });
    const [row] = await app.container
      .get(DRIZZLE)
      .db.insert(userLimit)
      .values({ userId: p.userId, type: 'deposit', period: 'daily', amount: '100', currency: null })
      .returning();

    const player = await p.client.put('/compliance/limits', {
      type: 'deposit',
      amount: '10',
      minutes: null,
      currency: 'USD',
      period: 'daily',
    });
    expect(player.status).toBe(409);
    expect(JSON.stringify(await readJson(player))).toContain('operator fix is required');

    // Read in the player's currency (USD): 500 is a raise, 80 a lowering.
    expect(
      (await setLimit(p.userId, { type: 'deposit', amount: '500', currency: 'USD' })).status,
    ).toBe(409);
    expect(
      (await setLimit(p.userId, { type: 'deposit', amount: '80', currency: 'USD' })).status,
    ).toBe(200);
    const [repaired] = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(userLimit)
      .where(eq(userLimit.id, row!.id));
    expect(repaired).toMatchObject({ currency: 'USD', amount: '80.000000000000000000' });
  });
});

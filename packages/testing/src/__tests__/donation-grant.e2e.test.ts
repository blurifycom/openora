import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import {
  WALLET_COMMANDS,
  type BonusGrantTerms,
  type WalletCreditArgs,
} from '@openora/core/contracts';
import { wallet, walletBalance, walletTransaction } from '@openora/core/wallet/schema';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import {
  asAdmin,
  readJson,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
  bootE2e,
  closeE2e,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const TERMS: BonusGrantTerms = { wageringMultiplier: '3', expiryDays: 30 };
const DAY_MS = 24 * 60 * 60 * 1000;

const drizzle = () => app.container.get(DRIZZLE).db;
const commands = () => app.container.get(WALLET_COMMANDS);

const player = (label: string) =>
  registerAndMaterializePlayer(app, { email: `donation-${label}-${randomUUID()}@example.test` });

async function deposit(client: TestClient, amount: string) {
  const res = await client.post('/wallet/deposit', {
    amount,
    currency: 'USD',
    idempotencyKey: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

const credit = (over: Record<string, unknown> & { userId: string }) =>
  drizzle().transaction((tx) =>
    commands().credit(tx, {
      amount: '10',
      currency: 'USD',
      type: 'donation',
      allowNewWallet: true,
      providerRef: { providerName: 'chat', providerRefId: randomUUID() },
      terms: TERMS,
      ...over,
    } as WalletCreditArgs),
  );

const donate = (senderId: string, recipientId: string, amount: string, providerRefId: string) =>
  drizzle().transaction(async (tx) => {
    const providerRef = { providerName: 'chat', providerRefId };
    const debited = await commands().debit(tx, {
      userId: senderId,
      amount,
      currency: 'USD',
      type: 'donation',
      providerRef,
    });
    if (!debited.ok) {
      return { debited, credited: null };
    }
    const credited = await commands().credit(tx, {
      userId: recipientId,
      amount,
      currency: 'USD',
      type: 'donation',
      allowNewWallet: true,
      providerRef,
      terms: TERMS,
    });
    return { debited, credited };
  });

const grantsOf = (userId: string) =>
  drizzle().select().from(promoGrant).where(eq(promoGrant.userId, userId));

const ledgerOf = (userId: string) =>
  drizzle()
    .select({ type: walletTransaction.type, direction: walletTransaction.direction })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(eq(wallet.userId, userId));

async function cashOf(userId: string) {
  const rows = await drizzle()
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(eq(wallet.userId, userId));
  return rows.map((row) => row.amount);
}

const walletsOf = (userId: string) =>
  drizzle().select().from(wallet).where(eq(wallet.userId, userId));

beforeAll(async () => {
  ({ db, app } = await bootE2e());
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('a donation credited to its recipient', () => {
  it('lands on a wagered donation grant, never on the real-money ledger', async () => {
    const { client, userId } = await player('grant');
    await deposit(client, '5');

    const outcome = await credit({ userId });

    expect(outcome.ok).toBe(true);
    const grants = await grantsOf(userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      source: 'donation',
      currency: 'USD',
      status: 'active',
      grantedAmount: '10.000000000000000000',
      bonusBalance: '10.000000000000000000',
      wageringRequired: '30.000000000000000000',
    });
    const expiresInDays = ((grants[0]?.expiresAt.getTime() ?? 0) - Date.now()) / DAY_MS;
    expect(expiresInDays).toBeGreaterThan(29.9);
    expect(expiresInDays).toBeLessThanOrEqual(30);
    expect((await ledgerOf(userId)).map((l) => l.type)).toEqual(['deposit']);
    expect(await cashOf(userId)).toEqual(['5.000000000000000000']);
  });

  const MISSING_REF: [string, Record<string, unknown>][] = [
    ['an empty reference', { providerRef: { providerName: 'chat', providerRefId: '' } }],
    ['no reference at all', { providerRef: undefined }],
  ];

  for (const [label, override] of MISSING_REF) {
    it(`refuses ${label} and writes no grant, ledger row or cash`, async () => {
      const { client, userId } = await player('missing-ref');
      await deposit(client, '5');
      const cashBefore = await cashOf(userId);
      const ledgerBefore = await ledgerOf(userId);

      await expect(credit({ userId, ...override })).rejects.toMatchObject({
        name: 'WalletBonusSourceRefRequiredError',
      });

      expect(await grantsOf(userId)).toHaveLength(0);
      expect(await ledgerOf(userId)).toEqual(ledgerBefore);
      expect(await cashOf(userId)).toEqual(cashBefore);
    });
  }

  it('reports a currency mismatch without a grant or cash', async () => {
    const { client, userId } = await player('mismatch');
    await deposit(client, '5');

    const outcome = await credit({ userId, currency: 'EUR' });

    expect(outcome).toEqual({ ok: false, reason: 'currency mismatch' });
    expect(await grantsOf(userId)).toHaveLength(0);
    expect(await cashOf(userId)).toEqual(['5.000000000000000000']);
  });

  it('opens a wallet for a recipient that has none only when asked to, and still pays no cash', async () => {
    const closed = await player('no-wallet-closed');
    const open = await player('no-wallet-open');

    expect(await credit({ userId: closed.userId, allowNewWallet: false })).toEqual({
      ok: false,
      reason: 'wallet not found',
    });
    expect(await credit({ userId: open.userId })).toMatchObject({ ok: true, moved: false });

    expect(await grantsOf(closed.userId)).toHaveLength(0);
    expect(await walletsOf(closed.userId)).toHaveLength(0);
    expect(await grantsOf(open.userId)).toHaveLength(1);
    expect(await ledgerOf(open.userId)).toEqual([]);
  });
});

describe('a donation reference shared with another bonus source', () => {
  it('keeps a gift and a donation under one reference as two grants, each deduped on its own', async () => {
    const { userId } = await player('shared-ref');
    const providerRef = { providerName: 'chat', providerRefId: randomUUID() };

    const outcomes = await Promise.all([
      credit({ userId, type: 'gift', providerRef }),
      credit({ userId, type: 'donation', providerRef, amount: '25' }),
    ]);
    outcomes.push(
      await credit({ userId, type: 'donation', providerRef, amount: '25' }),
      await credit({ userId, type: 'gift', providerRef }),
    );

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const grants = await grantsOf(userId);
    expect(grants.map((g) => [g.source, g.grantedAmount]).sort()).toEqual([
      ['donation', '25.000000000000000000'],
      ['gift', '10.000000000000000000'],
    ]);
  });

  it('refuses two different amounts raced under one donation reference, granting one', async () => {
    const { userId } = await player('race-amount');
    const providerRef = { providerName: 'chat', providerRefId: randomUUID() };

    const results = await Promise.allSettled([
      credit({ userId, amount: '10', providerRef }),
      credit({ userId, amount: '11', providerRef }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await grantsOf(userId)).toHaveLength(1);
  });

  it('leaves gift and rain on their own source and cashback and bonus on the cash ledger', async () => {
    const { userId } = await player('regression');

    await credit({ userId, type: 'gift' });
    await credit({ userId, type: 'rain' });
    await credit({ userId, type: 'cashback', providerRef: undefined, terms: undefined });
    await credit({ userId, type: 'bonus', providerRef: undefined, terms: undefined });

    expect((await grantsOf(userId)).map((g) => g.source).sort()).toEqual(['gift', 'rain']);
    expect((await ledgerOf(userId)).map((l) => l.type).sort()).toEqual(['bonus', 'cashback']);
  });
});

describe('a donation between two players', () => {
  it('moves the sender once and grants once when the same donation is delivered again, also in parallel', async () => {
    const sender = await player('replay-sender');
    const recipient = await player('replay-recipient');
    await deposit(sender.client, '50');
    const providerRefId = randomUUID();

    await Promise.all([
      donate(sender.userId, recipient.userId, '10', providerRefId),
      donate(sender.userId, recipient.userId, '10', providerRefId),
    ]);
    await donate(sender.userId, recipient.userId, '10', providerRefId);

    expect(await grantsOf(recipient.userId)).toHaveLength(1);
    expect((await ledgerOf(sender.userId)).filter((l) => l.type === 'donation')).toHaveLength(1);
    expect(await cashOf(sender.userId)).toEqual(['40.000000000000000000']);
  });

  it("shows each side only its own leg: the sender's debit and the recipient's grant", async () => {
    const sender = await player('sender');
    const recipient = await player('recipient');
    await deposit(sender.client, '50');

    expect(await donate(sender.userId, recipient.userId, '10', randomUUID())).toMatchObject({
      credited: { ok: true },
    });

    const recipientGrants = await readJson(await recipient.client.get('/promo/grants'));
    expect(recipientGrants.items).toEqual([
      expect.objectContaining({ source: 'donation', grantedAmount: '10.000000000000000000' }),
    ]);
    const senderGrants = await readJson(await sender.client.get('/promo/grants'));
    expect(senderGrants).toMatchObject({ items: [], total: 0 });

    const donationsQuery = '/wallet/transactions?page=1&limit=50&types[]=donation';
    const senderHistory = await readJson(await sender.client.get(donationsQuery));
    expect(senderHistory.total).toBe(1);
    expect(senderHistory.items[0]).toMatchObject({
      type: 'donation',
      direction: 'debit',
      amount: '10.000000000000000000',
    });
    const recipientHistory = await readJson(await recipient.client.get(donationsQuery));
    expect(recipientHistory.total).toBe(1);
    expect(recipientHistory.items[0]).toMatchObject({ type: 'donation', direction: 'credit' });
    expect(recipientHistory.items[0].id).not.toBe(senderHistory.items[0].id);
  });

  it('leaves a recipient with no real balance nothing to withdraw', async () => {
    const sender = await player('sender-withdraw');
    const recipient = await player('recipient-withdraw');
    await deposit(sender.client, '50');
    await donate(sender.userId, recipient.userId, '10', randomUUID());

    const res = await recipient.client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '10',
      currency: 'USD',
    });

    expect(res.status).toBe(400);
    expect(await grantsOf(recipient.userId)).toEqual([
      expect.objectContaining({ status: 'active', bonusBalance: '10.000000000000000000' }),
    ]);
  });
});

describe('who can see or create a donation', () => {
  it("hides one player's donation grant and debit from another and from an anonymous caller", async () => {
    const a = await player('authz-a');
    const b = await player('authz-b');
    await deposit(a.client, '50');
    await donate(a.userId, a.userId, '10', randomUUID());
    const [grant] = await grantsOf(a.userId);

    expect((await readJson(await b.client.get('/promo/grants'))).items).toEqual([]);
    expect(
      (await readJson(await b.client.get('/wallet/transactions?page=1&limit=50'))).items,
    ).toEqual([]);
    expect((await b.client.get(`/promo/grants/${grant?.id}`)).status).toBe(404);
    expect((await b.client.get(`/promo/grants/${grant?.id}/entries`)).status).toBe(404);
    expect((await b.client.get(`/wallet/transactions/${a.userId}`)).status).toBe(403);
    expect((await app.app.request('/promo/grants')).status).toBe(401);
  });

  it('lists a donation in the backoffice views for an admin and refuses a player', async () => {
    const sender = await player('admin-sender');
    const recipient = await player('admin-recipient');
    await deposit(sender.client, '50');
    await donate(sender.userId, recipient.userId, '10', randomUUID());

    const list = await readJson(
      await admin.get(`/backoffice/transactions?type=donation&userId=${sender.userId}`),
    );
    const detail = await admin.get(`/backoffice/transactions/${list.items[0].id}`);
    const perPlayer = await admin.get(`/wallet/transactions/${sender.userId}`);
    const grants = await readJson(
      await admin.get(`/backoffice/promo/players/${recipient.userId}/grants`),
    );

    expect(list.items.map((i: { type: string }) => i.type)).toEqual(['donation']);
    expect(detail.status).toBe(200);
    expect((await readJson(detail)).type).toBe('donation');
    expect(perPlayer.status).toBe(200);
    expect(grants.map((g: { source: string }) => g.source)).toEqual(['donation']);

    const refused = [
      await sender.client.get('/backoffice/transactions?type=donation'),
      await sender.client.get(`/backoffice/promo/players/${recipient.userId}/grants`),
      await sender.client.post(`/backoffice/promo/grants/${grants[0].id}/forfeit`, {
        id: grants[0].id,
        note: 'a player trying to forfeit it',
      }),
    ];
    expect(refused.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(await grantsOf(recipient.userId)).toEqual([
      expect.objectContaining({ status: 'active' }),
    ]);
  });
});

describe('a tip between two players', () => {
  it('stays a cash transfer on the ledger, with the bonus engine bound', async () => {
    const sender = await player('tip-sender');
    const recipient = await player('tip-recipient');
    await deposit(sender.client, '50');
    await deposit(recipient.client, '5');
    const transferId = randomUUID();

    await drizzle().transaction(async (tx) => {
      await commands().debit(tx, {
        userId: sender.userId,
        amount: '10',
        currency: 'USD',
        type: 'tip',
        providerRef: { providerName: 'chat', providerRefId: `${transferId}:debit` },
      });
      await commands().credit(tx, {
        userId: recipient.userId,
        amount: '10',
        currency: 'USD',
        type: 'tip',
        providerRef: { providerName: 'chat', providerRefId: `${transferId}:credit` },
      });
    });

    const tipsQuery = '/wallet/transactions?page=1&limit=50&types[]=tip';
    expect((await readJson(await sender.client.get(tipsQuery))).items).toEqual([
      expect.objectContaining({ type: 'tip', direction: 'debit', amount: '10.000000000000000000' }),
    ]);
    expect((await readJson(await recipient.client.get(tipsQuery))).items).toEqual([
      expect.objectContaining({
        type: 'tip',
        direction: 'credit',
        amount: '10.000000000000000000',
      }),
    ]);
    const adminTips = await Promise.all(
      [sender.userId, recipient.userId].map(
        async (userId) =>
          (await readJson(await admin.get(`/backoffice/transactions?type=tip&userId=${userId}`)))
            .items,
      ),
    );
    expect(adminTips).toEqual([
      [
        expect.objectContaining({
          type: 'tip',
          userId: sender.userId,
          amount: '10.000000000000000000',
        }),
      ],
      [
        expect.objectContaining({
          type: 'tip',
          userId: recipient.userId,
          amount: '10.000000000000000000',
        }),
      ],
    ]);
    expect(await cashOf(recipient.userId)).toEqual(['15.000000000000000000']);
    expect(await cashOf(sender.userId)).toEqual(['40.000000000000000000']);
    expect(await grantsOf(recipient.userId)).toHaveLength(0);
  });
});

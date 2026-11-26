import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { WALLET_COMMANDS } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { DRIZZLE } from '@openora/core/server';
import {
  LimitViewSchema,
  RgExclusionSchema,
  RgSectionSchema,
} from '@openora/core/compliance/contract';
import { rgExclusion, userLimit } from '@openora/core/compliance/schema';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { newStaff, type TestClient } from '../../index.js';
import { deliverWebhook, newDepositScenario, type WalletE2e } from './wallet.js';

export const limitBody = (
  currency: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'deposit',
  amount: '100',
  minutes: null,
  currency,
  period: 'daily',
  ...overrides,
});

export const adminLimitBody = (
  userId: string,
  currency: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  userId,
  ...limitBody(currency),
  reason: 'e2e admin limit',
  confirm: true,
  ...overrides,
});

export async function readBody(res: Response): Promise<{ status: number; body: unknown }> {
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

export async function putLimit(
  client: TestClient,
  currency: string,
  overrides: Record<string, unknown> = {},
) {
  const { status, body } = await readBody(
    await client.put('/compliance/limits', limitBody(currency, overrides)),
  );
  if (status !== 200) {
    throw new Error(`put limit failed (${status}): ${JSON.stringify(body)}`);
  }
  return LimitViewSchema.parse(body);
}

export function rawPutLimit(
  client: TestClient,
  currency: string,
  overrides: Record<string, unknown> = {},
) {
  return client.put('/compliance/limits', limitBody(currency, overrides)).then(readBody);
}

export function adminPutLimit(
  admin: TestClient,
  userId: string,
  currency: string,
  overrides: Record<string, unknown> = {},
) {
  return admin
    .put(`/compliance/players/${userId}/limits`, adminLimitBody(userId, currency, overrides))
    .then(readBody);
}

export function postDeposit(client: TestClient, currency: string, amount: string) {
  return client
    .post('/wallet/deposit', { amount, currency, idempotencyKey: randomUUID() })
    .then(readBody);
}

export async function depositRows(e2e: WalletE2e, userId: string) {
  return e2e.app.container
    .get(DRIZZLE)
    .db.select({ id: walletTransaction.id, amount: walletTransaction.amount })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(and(eq(wallet.userId, userId), eq(walletTransaction.type, 'deposit')));
}

export async function limitRow(e2e: WalletE2e, limitId: string) {
  const [row] = await e2e.app.container
    .get(DRIZZLE)
    .db.select()
    .from(userLimit)
    .where(eq(userLimit.id, limitId));
  return row;
}

export async function setPendingWindow(
  e2e: WalletE2e,
  limitId: string,
  window: { effectiveAt: Date; expiresAt: Date },
) {
  await e2e.app.container
    .get(DRIZZLE)
    .db.update(userLimit)
    .set({ pendingEffectiveAt: window.effectiveAt, pendingExpiresAt: window.expiresAt })
    .where(eq(userLimit.id, limitId));
}

export const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000);

export const complianceManager = async (e2e: WalletE2e) =>
  (await newStaff(e2e.app, 'rg-compliance', 'compliance-manager')).client;

export const readOnlyAdmin = async (e2e: WalletE2e) =>
  (await newStaff(e2e.app, 'rg-readonly', 'admin')).client;

export const newRgPlayer = (e2e: WalletE2e, minDeposit = '1') =>
  newDepositScenario(e2e, { minDeposit });

export type RgPlayer = Awaited<ReturnType<typeof newRgPlayer>>;

export const rgSection = async (client: TestClient) => {
  const { status, body } = await readBody(await client.get('/compliance/rg/me'));
  if (status !== 200) {
    throw new Error(`rg section failed (${status}): ${JSON.stringify(body)}`);
  }
  return RgSectionSchema.parse(body);
};

export const parseExclusion = (body: unknown) => RgExclusionSchema.parse(body);

export const errorCodeOf = (body: unknown) => z.object({ code: z.string() }).parse(body).code;

export async function exclusionRows(e2e: WalletE2e, userId: string) {
  return e2e.app.container
    .get(DRIZZLE)
    .db.select()
    .from(rgExclusion)
    .where(eq(rgExclusion.userId, userId));
}

export const scaled = (amount: string) => `${amount}.${'0'.repeat(18)}`;

export async function fundPlayer(e2e: WalletE2e, player: RgPlayer, amount: string) {
  const res = await deliverWebhook(e2e, player.deposit({ amount }));
  if (res.status !== 200) {
    throw new Error(`funding deposit failed (${res.status}): ${await res.text()}`);
  }
}

export function placeBet(e2e: WalletE2e, userId: string, currency: string, amount: string) {
  const { db } = e2e.app.container.get(DRIZZLE);
  const commands = e2e.app.container.get(WALLET_COMMANDS);
  return db.transaction((tx) => commands.debit(tx, { userId, amount, type: 'bet', currency }));
}

export async function emailOf(e2e: WalletE2e, userId: string) {
  const [row] = await e2e.app.container
    .get(DRIZZLE)
    .db.select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  if (!row) {
    throw new Error(`no user ${userId}`);
  }
  return row.email;
}

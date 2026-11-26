import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, asc, eq } from 'drizzle-orm';
import { vi } from 'vitest';
import * as z from 'zod';
import { BONUS_GRANTS, WALLET_COMMANDS, type BonusGrantArgs } from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { DRIZZLE } from '@openora/core/server';
import {
  AdminGrantSchema,
  BonusBalanceSchema,
  PlayerGrantEntrySchema,
  PlayerGrantSchema,
  PlayerOfferSchema,
  PromoOfferSchema,
  PublicOfferSchema,
  WagerWeightProfileDetailSchema,
  type CreatePromoOfferInput,
} from '@openora/core/promo/contracts/bonus';
import {
  promoGrant,
  promoGrantEntry,
  promoOptIn,
  type PromoGrant,
} from '@openora/core/promo/schema/bonus';
import { flushAudit, type TestClient } from '../../index.js';
import {
  bootWalletE2e,
  deliverWebhook,
  newDepositScenario,
  type DepositScenario,
  type WalletE2e,
} from './wallet.js';

export const LI_IP = '203.0.113.40';
export const DE_IP = '203.0.113.10';
const BET_PROVIDER = 'bonus-e2e-provider';

export const bootBonusE2e = () =>
  bootWalletE2e([
    {
      id: 'testing-geo-ip',
      path: fileURLToPath(new URL('../../test-geo-ip-plugin.ts', import.meta.url)),
    },
    {
      id: 'testing-bonus-concurrency',
      path: fileURLToPath(new URL('./test-bonus-concurrency-plugin.ts', import.meta.url)),
    },
  ]);

export const dbOf = (e2e: WalletE2e) => e2e.app.container.get(DRIZZLE).db;

export const money = (amount: string) => `${amount}.${'0'.repeat(18)}`;

export async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text();
  return text === '' ? null : JSON.parse(text);
}

export const uniqueKey = (prefix = 'e2e-offer') => `${prefix}-${randomUUID()}`;

type OfferOverrides = Partial<
  Omit<CreatePromoOfferInput, 'terms' | 'rules'> & {
    terms: Partial<CreatePromoOfferInput['terms']>;
    rules: Partial<CreatePromoOfferInput['rules']>;
  }
>;

export function offerBody(currency: string, overrides: OfferOverrides = {}) {
  const { terms, rules, ...rest } = overrides;
  return {
    key: uniqueKey(),
    name: 'E2E welcome bonus',
    status: 'active',
    currency,
    matchPercent: '50',
    maxGrantAmount: '1000',
    minDeposit: '10',
    requiresOptIn: true,
    terms: { wageringMultiplier: '10', expiryDays: 30, ...terms },
    rules: { firstDepositOnly: false, ...rules },
    ...rest,
  };
}

export async function createOffer(
  admin: TestClient,
  currency: string,
  overrides: OfferOverrides = {},
) {
  const res = await admin.post('/backoffice/promo/offers', offerBody(currency, overrides));
  const body = await bodyOf(res);
  if (res.status !== 200) {
    throw new Error(`offer create failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return PromoOfferSchema.parse(body);
}

export async function optIn(client: TestClient, offerId: string) {
  const res = await client.post(`/promo/offers/${offerId}/opt-in`);
  return { status: res.status, body: await bodyOf(res) };
}

export async function optInOk(client: TestClient, offerId: string) {
  const { status, body } = await optIn(client, offerId);
  if (status !== 200) {
    throw new Error(`opt-in failed (${status}): ${JSON.stringify(body)}`);
  }
  return PlayerOfferSchema.parse(body);
}

export async function listOffers(client: TestClient) {
  const res = await client.get('/promo/offers');
  if (res.status !== 200) {
    throw new Error(`offer list failed (${res.status})`);
  }
  return z.array(PlayerOfferSchema).parse(await bodyOf(res));
}

export async function listPublicOffers(e2e: WalletE2e, ip: string) {
  const res = await e2e.app.app.request('/promo/offers/public', {
    method: 'GET',
    headers: { 'x-real-ip': ip },
  });
  if (res.status !== 200) {
    throw new Error(`public offers failed (${res.status})`);
  }
  return z.array(PublicOfferSchema).parse(await bodyOf(res));
}

export async function fundPlayer(e2e: WalletE2e, scenario: DepositScenario, amount: string) {
  const res = await deliverWebhook(e2e, scenario.deposit({ amount }));
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

export const grantRows = (e2e: WalletE2e, userId: string): Promise<PromoGrant[]> =>
  dbOf(e2e)
    .select()
    .from(promoGrant)
    .where(eq(promoGrant.userId, userId))
    .orderBy(asc(promoGrant.createdAt));

export const entryRows = (e2e: WalletE2e, grantId: string) =>
  dbOf(e2e)
    .select()
    .from(promoGrantEntry)
    .where(eq(promoGrantEntry.grantId, grantId))
    .orderBy(asc(promoGrantEntry.createdAt));

export const optInRows = (e2e: WalletE2e, userId: string, offerId: string) =>
  dbOf(e2e)
    .select()
    .from(promoOptIn)
    .where(and(eq(promoOptIn.userId, userId), eq(promoOptIn.offerId, offerId)));

export async function waitForGrant(
  e2e: WalletE2e,
  userId: string,
  offerId: string,
): Promise<PromoGrant> {
  return vi.waitFor(
    async () => {
      const [row] = await dbOf(e2e)
        .select()
        .from(promoGrant)
        .where(and(eq(promoGrant.userId, userId), eq(promoGrant.offerId, offerId)));
      if (!row) {
        throw new Error('no grant yet');
      }
      return row;
    },
    { timeout: 15_000, interval: 100 },
  );
}

export async function waitForBankedDeposit(
  e2e: WalletE2e,
  userId: string,
  offerId: string,
  amount: string,
) {
  return vi.waitFor(
    async () => {
      const [row] = await optInRows(e2e, userId, offerId);
      if (!row || row.accumulatedDeposit !== money(amount)) {
        throw new Error(`accumulated ${row?.accumulatedDeposit ?? 'none'}`);
      }
      return row;
    },
    { timeout: 15_000, interval: 100 },
  );
}

export async function directGrant(
  e2e: WalletE2e,
  userId: string,
  currency: string,
  overrides: Partial<BonusGrantArgs> = {},
) {
  const outcome = await dbOf(e2e).transaction((tx) =>
    e2e.app.container.get(BONUS_GRANTS).grant(tx, {
      userId,
      currency,
      amount: '20',
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      terms: { wageringMultiplier: '10', expiryDays: 30 },
      ...overrides,
    }),
  );
  if (!outcome.ok) {
    throw new Error(`grant refused: ${outcome.reason}`);
  }
  return outcome.grantId;
}

export async function getGrant(client: TestClient, grantId: string) {
  const res = await client.get(`/promo/grants/${grantId}`);
  return { status: res.status, body: await bodyOf(res) };
}

export async function grantOk(client: TestClient, grantId: string) {
  const { status, body } = await getGrant(client, grantId);
  if (status !== 200) {
    throw new Error(`grant read failed (${status})`);
  }
  return PlayerGrantSchema.parse(body);
}

export async function listGrants(client: TestClient) {
  const res = await client.get('/promo/grants');
  if (res.status !== 200) {
    throw new Error(`grant list failed (${res.status})`);
  }
  return z.object({ items: z.array(PlayerGrantSchema) }).parse(await bodyOf(res)).items;
}

export async function grantEntries(client: TestClient, grantId: string) {
  const res = await client.get(`/promo/grants/${grantId}/entries`);
  if (res.status !== 200) {
    throw new Error(`entries failed (${res.status})`);
  }
  return z.object({ items: z.array(PlayerGrantEntrySchema) }).parse(await bodyOf(res)).items;
}

export async function bonusBalances(client: TestClient) {
  const res = await client.get('/promo/balance');
  if (res.status !== 200) {
    throw new Error(`balance failed (${res.status})`);
  }
  return z.array(BonusBalanceSchema).parse(await bodyOf(res));
}

export async function activate(client: TestClient, grantId: string) {
  const res = await client.post(`/promo/grants/${grantId}/activate`);
  return { status: res.status, body: await bodyOf(res) };
}

export async function forfeit(
  admin: TestClient,
  grantId: string,
  note = 'e2e forfeit for a test case',
) {
  const res = await admin.post(`/backoffice/promo/grants/${grantId}/forfeit`, { note });
  return { status: res.status, body: await bodyOf(res) };
}

export const parseAdminGrant = (body: unknown) => AdminGrantSchema.parse(body);

export async function createWeightProfile(
  admin: TestClient,
  weights: {
    scope: 'game' | 'category' | 'product' | 'default';
    scopeRef: string | null;
    contributionPercent: string;
  }[],
) {
  const created = await admin.post('/backoffice/promo/weight-profiles', {
    name: `e2e-profile-${randomUUID()}`,
  });
  const profile = WagerWeightProfileDetailSchema.parse(await bodyOf(created));
  await setWeights(admin, profile.id, weights);
  return profile.id;
}

export async function setWeights(
  admin: TestClient,
  profileId: string,
  weights: {
    scope: 'game' | 'category' | 'product' | 'default';
    scopeRef: string | null;
    contributionPercent: string;
  }[],
) {
  const res = await admin.put(`/backoffice/promo/weight-profiles/${profileId}/weights`, {
    weights,
  });
  if (res.status !== 200) {
    throw new Error(`set weights failed (${res.status}): ${await res.text()}`);
  }
}

export function placeBet(
  e2e: WalletE2e,
  userId: string,
  currency: string,
  amount: string,
  gameId = 'game-1',
  roundId = randomUUID(),
) {
  return dbOf(e2e).transaction((tx) =>
    e2e.app.container.get(WALLET_COMMANDS).debit(tx, {
      userId,
      amount,
      type: 'bet',
      currency,
      context: { provider: BET_PROVIDER, product: 'casino', gameId },
      providerRef: {
        providerName: BET_PROVIDER,
        providerRefId: `bet-${roundId}`,
        externalRoundId: roundId,
      },
    }),
  );
}

export async function auditFor(e2e: WalletE2e, action: string, resourceId: string) {
  await flushAudit(e2e.app);
  return dbOf(e2e)
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)));
}

export async function newBonusPlayer(e2e: WalletE2e, minDeposit = '1') {
  return newDepositScenario(e2e, { minDeposit });
}

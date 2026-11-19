import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { BONUS_GRANTS } from '@openora/core/contracts';
import {
  promoGrant,
  promoOffer,
  promoWeight,
  promoWeightProfile,
} from '@openora/core/promo/schema/bonus';
import { registerAndMaterializePlayer, bootE2e, closeE2e, readJson, type E2e } from '../index.js';

let e2e: E2e;
let weightProfileId: string;

const drizzle = () => e2e.app.container.get(DRIZZLE).db;

async function grantBonus(userId: string, expiryDays = 30) {
  const outcome = await drizzle().transaction((tx) =>
    e2e.app.container.get(BONUS_GRANTS).grant(tx, {
      userId,
      currency: 'USD',
      amount: '50',
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      terms: { wageringMultiplier: '5', expiryDays, weightProfileId },
    }),
  );
  if (!outcome.ok) {
    throw new Error('grantBonus: grant was refused');
  }
  return outcome;
}

const player = () =>
  registerAndMaterializePlayer(e2e.app, { email: `activate-${randomUUID()}@example.test` });

beforeAll(async () => {
  e2e = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'test-bonus-single-slot-config',
        path: fileURLToPath(
          new URL('./fixtures/test-bonus-single-slot-config-plugin.ts', import.meta.url),
        ),
      },
    ],
  });
  const [profile] = await drizzle()
    .insert(promoWeightProfile)
    .values({ name: `activate-${randomUUID()}` })
    .returning();
  if (!profile) {
    throw new Error('seed profile: query returned no row');
  }
  weightProfileId = profile.id;
  await drizzle().insert(promoWeight).values({
    profileId: weightProfileId,
    scope: 'default',
    scopeRef: null,
    contributionPercent: '100',
  });
}, 60_000);

afterAll(async () => {
  await closeE2e(e2e);
});

describe('POST /promo/grants/{id}/activate', () => {
  it('activates a pending grant once the slot is free, restarting its window', async () => {
    const { client, userId } = await player();
    const first = await grantBonus(userId);
    const second = await grantBonus(userId, 7);
    expect(second.ok && second.status).toBe('pending');
    const pendingId = second.ok ? second.grantId : '';
    await drizzle()
      .update(promoGrant)
      .set({ status: 'expired' })
      .where(eq(promoGrant.id, first.ok ? first.grantId : ''));

    const res = await client.post(`/promo/grants/${pendingId}/activate`, {});

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({ id: pendingId, status: 'active' });
    expect(body.activatedAt).toEqual(expect.any(String));
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });

  it('answers 409 BONUS_SLOT_TAKEN while another bonus holds the slot', async () => {
    const { client, userId } = await player();
    await grantBonus(userId);
    const second = await grantBonus(userId);

    const res = await client.post(`/promo/grants/${second.ok ? second.grantId : ''}/activate`, {});

    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ data: { code: 'BONUS_SLOT_TAKEN' } });
  });

  it("answers 404 for another player's pending grant and leaves it pending", async () => {
    const owner = await player();
    await grantBonus(owner.userId);
    const second = await grantBonus(owner.userId);
    const pendingId = second.ok ? second.grantId : '';
    const intruder = await player();

    const res = await intruder.client.post(`/promo/grants/${pendingId}/activate`, {});

    expect(res.status).toBe(404);
    const [row] = await drizzle().select().from(promoGrant).where(eq(promoGrant.id, pendingId));
    expect(row?.status).toBe('pending');
  });
});

describe('POST /promo/offers/{id}/opt-in under a single slot', () => {
  it('answers 409 BONUS_SLOT_TAKEN while another bonus is active in the offer currency', async () => {
    const { client, userId } = await player();
    await grantBonus(userId);
    const [offer] = await drizzle()
      .insert(promoOffer)
      .values({
        key: `slot-${randomUUID()}`,
        name: 'Reload',
        status: 'active',
        currency: 'USD',
        matchPercent: '100',
        maxGrantAmount: '100',
        minDeposit: '10',
        terms: { wageringMultiplier: '5', expiryDays: 30 },
        rules: { firstDepositOnly: false },
        requiresOptIn: true,
      })
      .returning();

    const res = await client.post(`/promo/offers/${offer?.id}/opt-in`, {});

    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ data: { code: 'BONUS_SLOT_TAKEN' } });
  });
});

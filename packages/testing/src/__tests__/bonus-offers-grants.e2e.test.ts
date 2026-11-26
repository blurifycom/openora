import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import {
  JOB_QUEUE,
  MaxBetExceededError,
  queue,
  type BonusFundSettings,
} from '@openora/core/contracts';
import { CountryRuleSchema } from '@openora/core/compliance/contract';
import { PromoOfferSchema } from '@openora/core/promo/contracts/bonus';
import {
  promoGrant,
  promoGrantEntry,
  promoOffer,
  promoOptIn,
  promoOptInDeposit,
} from '@openora/core/promo/schema/bonus';
import { newStaff } from '../index.js';
import {
  activate,
  auditFor,
  bodyOf,
  bonusBalances,
  bootBonusE2e,
  createOffer,
  createWeightProfile,
  DE_IP,
  dbOf,
  directGrant,
  entryRows,
  forfeit,
  fundPlayer,
  getGrant,
  grantEntries,
  grantOk,
  grantRows,
  listGrants,
  listOffers,
  listPublicOffers,
  loseRound,
  money,
  newBonusPlayer,
  offerBody,
  optIn,
  optInOk,
  optInRows,
  parseAdminGrant,
  placeBet,
  reverseBet,
  setWeights,
  LI_IP,
  uniqueKey,
  waitForGrant,
  waitForOptInDeposits,
} from './support/bonus.js';
import { balanceOf, closeWalletE2e, deliverWebhook, type WalletE2e } from './support/wallet.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootBonusE2e();
}, 120_000);

afterAll(() => closeWalletE2e(e2e));

const conflict = expect.objectContaining({ code: 'CONFLICT', status: 409 });
const notFound = expect.objectContaining({ code: 'NOT_FOUND', status: 404 });

describe('player opts in and receives a deposit bonus', () => {
  it('a player opts in to an active offer and a later deposit at or above the minimum creates an active grant with the matched amount and wagering requirement', async () => {
    const player = await newBonusPlayer(e2e);
    const offer = await createOffer(e2e.admin, player.currency, {
      matchPercent: '50',
      minDeposit: '10',
      terms: { wageringMultiplier: '10', expiryDays: 30 },
    });
    await optInOk(player.client, offer.id);

    await fundPlayer(e2e, player, '40');

    const grant = await waitForGrant(e2e, player.userId, offer.id);
    expect(grant).toMatchObject({
      status: 'active',
      source: 'deposit',
      currency: player.currency,
      grantedAmount: money('20'),
      bonusBalance: money('20'),
      wageringRequired: money('200'),
      wageringProgress: money('0'),
    });
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('40'));
    const [optInRow] = await optInRows(e2e, player.userId, offer.id);
    expect(optInRow).toMatchObject({ grantId: grant.id, accumulatedDeposit: money('40') });
    expect(await entryRows(e2e, grant.id)).toEqual([
      expect.objectContaining({
        type: 'grant',
        bonusAmount: money('20'),
        balanceAfter: money('20'),
      }),
    ]);
    const visible = await grantOk(player.client, grant.id);
    expect(visible).toMatchObject({ status: 'active', offerKey: offer.key });
    expect(await auditFor(e2e, 'promo.bonus.granted', grant.id)).toHaveLength(1);
    const offers = await listOffers(player.client);
    expect(offers.find((o) => o.id === offer.id)).toMatchObject({ optedIn: true, claimed: true });
  });

  it('a deposit below the minimum deposit creates no grant and the opt-in stays open', async () => {
    const player = await newBonusPlayer(e2e);
    const offer = await createOffer(e2e.admin, player.currency, { minDeposit: '50' });
    await optInOk(player.client, offer.id);

    await fundPlayer(e2e, player, '20');

    const claim = await waitForOptInDeposits(e2e, player.userId, offer.id, 1);
    expect(claim).toMatchObject({ grantId: null, accumulatedDeposit: money('0') });
    expect(await grantRows(e2e, player.userId)).toEqual([]);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('20'));
    const offers = await listOffers(player.client);
    expect(offers.find((o) => o.id === offer.id)).toMatchObject({
      optedIn: true,
      claimed: false,
    });
  });

  it('a deposit in a currency other than the offer currency creates no grant', async () => {
    const player = await newBonusPlayer(e2e);
    const foreign = await newBonusPlayer(e2e);
    const matching = await createOffer(e2e.admin, player.currency, { minDeposit: '10' });
    const mismatched = await createOffer(e2e.admin, foreign.currency, { minDeposit: '10' });
    await optInOk(player.client, matching.id);
    await optInOk(player.client, mismatched.id);

    await fundPlayer(e2e, player, '40');

    await waitForGrant(e2e, player.userId, matching.id);
    const grants = await grantRows(e2e, player.userId);
    expect(grants.map((g) => g.offerId)).toEqual([matching.id]);
    const [claim] = await optInRows(e2e, player.userId, mismatched.id);
    expect(claim).toMatchObject({ grantId: null, accumulatedDeposit: money('0') });
    expect(
      await dbOf(e2e)
        .select()
        .from(promoOptInDeposit)
        .where(eq(promoOptInDeposit.optInId, claim?.id ?? '')),
    ).toEqual([]);
  });

  it('opting in to an inactive, expired or unknown offer is refused', async () => {
    const player = await newBonusPlayer(e2e);
    const draft = await createOffer(e2e.admin, player.currency, { status: 'draft' });
    const paused = await createOffer(e2e.admin, player.currency, { status: 'paused' });
    const expired = await createOffer(e2e.admin, player.currency, {
      validUntil: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const notYetOpen = await createOffer(e2e.admin, player.currency, {
      validFrom: new Date(Date.now() + 3_600_000).toISOString(),
    });

    for (const offer of [draft, paused, expired, notYetOpen]) {
      const refused = await optIn(player.client, offer.id);
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual(conflict);
      expect(await optInRows(e2e, player.userId, offer.id)).toEqual([]);
    }
    const unknown = await optIn(player.client, randomUUID());
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(notFound);
  });

  it('opting in twice to the same offer does not create a second slot', async () => {
    const player = await newBonusPlayer(e2e);
    const offer = await createOffer(e2e.admin, player.currency);

    const first = await optInOk(player.client, offer.id);
    const second = await optInOk(player.client, offer.id);

    expect(first.optedIn).toBe(true);
    expect(second).toEqual(first);
    expect(await optInRows(e2e, player.userId, offer.id)).toHaveLength(1);
    const [claim] = await optInRows(e2e, player.userId, offer.id);
    expect(await auditFor(e2e, 'promo.offer.claimed', claim?.id ?? '')).toHaveLength(1);
  });

  it('a deposit event delivered twice creates exactly one grant', async () => {
    const player = await newBonusPlayer(e2e);
    const marker = await newBonusPlayer(e2e);
    const offer = await createOffer(e2e.admin, player.currency, { minDeposit: '10' });
    const markerOffer = await createOffer(e2e.admin, marker.currency, { minDeposit: '10' });
    await optInOk(player.client, offer.id);
    await optInOk(marker.client, markerOffer.id);
    const deposit = player.deposit({ amount: '40' });
    expect((await deliverWebhook(e2e, deposit)).status).toBe(200);
    const grant = await waitForGrant(e2e, player.userId, offer.id);
    expect((await deliverWebhook(e2e, deposit)).status).toBe(200);
    const [counted] = await dbOf(e2e)
      .select()
      .from(promoOptInDeposit)
      .where(
        eq(promoOptInDeposit.optInId, (await optInRows(e2e, player.userId, offer.id))[0]?.id ?? ''),
      );
    await e2e.app.container.get(JOB_QUEUE).enqueue(queue('promo-offer-deposit'), {
      userId: player.userId,
      amount: '40',
      currency: player.currency,
      transactionId: counted?.transactionId,
    });
    await fundPlayer(e2e, marker, '40');
    await waitForGrant(e2e, marker.userId, markerOffer.id);

    const grants = await grantRows(e2e, player.userId);
    expect(grants.map((g) => g.id)).toEqual([grant.id]);
    expect(await entryRows(e2e, grant.id)).toHaveLength(1);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('40'));
  });

  it('a first-deposit-only offer is not used up by a deposit below its minimum', async () => {
    const player = await newBonusPlayer(e2e);
    const offer = await createOffer(e2e.admin, player.currency, {
      minDeposit: '30',
      rules: { firstDepositOnly: true },
    });
    await optInOk(player.client, offer.id);

    await fundPlayer(e2e, player, '5');
    const short = await waitForOptInDeposits(e2e, player.userId, offer.id, 1);
    expect(short).toMatchObject({ grantId: null, accumulatedDeposit: money('0') });
    expect(await grantRows(e2e, player.userId)).toEqual([]);

    await fundPlayer(e2e, player, '40');
    const granted = await waitForGrant(e2e, player.userId, offer.id);

    expect(granted).toMatchObject({ grantedAmount: money('20'), status: 'active' });
    expect((await optInRows(e2e, player.userId, offer.id))[0]).toMatchObject({
      grantId: granted.id,
      accumulatedDeposit: money('40'),
    });
  });

  it('opting in without a session is rejected as unauthorized', async () => {
    const player = await newBonusPlayer(e2e);
    const offer = await createOffer(e2e.admin, player.currency);

    const res = await e2e.app.app.request(`/promo/offers/${offer.id}/opt-in`, { method: 'POST' });

    expect(res.status).toBe(401);
    expect(await optInRows(e2e, player.userId, offer.id)).toEqual([]);
    expect(
      await dbOf(e2e).select().from(promoOptIn).where(eq(promoOptIn.offerId, offer.id)),
    ).toEqual([]);
  });

  it('the public offers list shows only active offers to a visitor and nothing to a refused country', async () => {
    const player = await newBonusPlayer(e2e);
    const active = await createOffer(e2e.admin, player.currency);
    const draft = await createOffer(e2e.admin, player.currency, { status: 'draft' });
    const expired = await createOffer(e2e.admin, player.currency, {
      validUntil: new Date(Date.now() - 3_600_000).toISOString(),
    });

    const visible = await listPublicOffers(e2e, DE_IP);

    const keys = visible.map((o) => o.key);
    expect(keys).toContain(active.key);
    expect(keys).not.toContain(draft.key);
    expect(keys).not.toContain(expired.key);
    expect(visible.find((o) => o.key === active.key)).not.toHaveProperty('terms');

    const blocked = await e2e.admin.post('/compliance/geo-rules', {
      countryCode: 'LI',
      action: 'block',
    });
    expect(blocked.status).toBe(200);
    try {
      expect(await listPublicOffers(e2e, LI_IP)).toEqual([]);
      expect((await listPublicOffers(e2e, DE_IP)).map((o) => o.key)).toContain(active.key);
    } finally {
      const rules = z
        .array(CountryRuleSchema)
        .parse(await bodyOf(await e2e.admin.get('/compliance/country-rules')));
      const reopened = await e2e.admin.put('/compliance/country-rules', {
        countryCode: 'LI',
        blacklisted: false,
        redirectIp: false,
        mirrorUrl: null,
        kycRequired: true,
        confirm: true,
        expectedUpdatedAt: rules.find((rule) => rule.countryCode === 'LI')?.updatedAt ?? null,
      });
      expect(reopened.status).toBe(200);
    }
    expect((await listPublicOffers(e2e, LI_IP)).map((o) => o.key)).toContain(active.key);
  });
});

describe('player reads and activates grants', () => {
  it("the player grant list and grant detail return only the caller's grants", async () => {
    const first = await newBonusPlayer(e2e);
    const second = await newBonusPlayer(e2e);
    const firstGrants = [
      await directGrant(e2e, first.userId, first.currency),
      await directGrant(e2e, first.userId, first.currency),
    ];
    const secondGrant = await directGrant(e2e, second.userId, second.currency);

    const mine = await listGrants(first.client);
    const theirs = await listGrants(second.client);

    expect(mine.map((g) => g.id).sort()).toEqual([...firstGrants].sort());
    expect(theirs.map((g) => g.id)).toEqual([secondGrant]);
    expect(await grantOk(first.client, firstGrants[0] ?? '')).toMatchObject({
      id: firstGrants[0],
      currency: first.currency,
    });
  });

  it("reading another player's grant by id returns not found", async () => {
    const owner = await newBonusPlayer(e2e);
    const stranger = await newBonusPlayer(e2e);
    const grantId = await directGrant(e2e, owner.userId, owner.currency);

    const detail = await getGrant(stranger.client, grantId);
    const entries = await stranger.client.get(`/promo/grants/${grantId}/entries`);

    expect(detail.status).toBe(404);
    expect(detail.body).toEqual(notFound);
    expect(entries.status).toBe(404);
    expect((await grantOk(owner.client, grantId)).id).toBe(grantId);
  });

  it('activating a pending grant moves it to active, restarts its window and is audited', async () => {
    const player = await newBonusPlayer(e2e);
    const first = await directGrant(e2e, player.userId, player.currency);
    const pending = await directGrant(e2e, player.userId, player.currency, {
      terms: { wageringMultiplier: '10', expiryDays: 7 },
    });
    expect((await grantOk(player.client, pending)).status).toBe('pending');
    expect((await forfeit(e2e.admin, first)).status).toBe(200);
    await dbOf(e2e)
      .update(promoGrant)
      .set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(promoGrant.id, pending));

    const res = await activate(player.client, pending);

    expect(res.status).toBe(200);
    const [row] = await dbOf(e2e).select().from(promoGrant).where(eq(promoGrant.id, pending));
    expect(row).toMatchObject({ status: 'active', bonusBalance: money('20') });
    expect(row?.activatedAt).toBeInstanceOf(Date);
    const remainingMs = (row?.expiresAt.getTime() ?? 0) - Date.now();
    expect(remainingMs).toBeGreaterThan(6.9 * 86_400_000);
    expect(remainingMs).toBeLessThanOrEqual(7 * 86_400_000);
    expect((await grantOk(player.client, pending)).status).toBe('active');
    const audit = await auditFor(e2e, 'promo.bonus.activated', pending);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: player.userId, actorType: 'player' });
  });

  it('activating a grant twice leaves a single activation entry', async () => {
    const player = await newBonusPlayer(e2e);
    const first = await directGrant(e2e, player.userId, player.currency);
    const pending = await directGrant(e2e, player.userId, player.currency);
    await forfeit(e2e.admin, first);

    const once = await activate(player.client, pending);
    const again = await activate(player.client, pending);

    expect(once.status).toBe(200);
    expect(again.status).toBe(409);
    expect(again.body).toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        status: 409,
        data: { code: 'BONUS_NOT_ACTIVATABLE' },
      }),
    );
    expect(await auditFor(e2e, 'promo.bonus.activated', pending)).toHaveLength(1);
    expect((await grantRows(e2e, player.userId)).filter((g) => g.status === 'active')).toHaveLength(
      1,
    );
  });

  it('activating a grant owned by another player is refused', async () => {
    const owner = await newBonusPlayer(e2e);
    const stranger = await newBonusPlayer(e2e);
    const first = await directGrant(e2e, owner.userId, owner.currency);
    const pending = await directGrant(e2e, owner.userId, owner.currency);
    await forfeit(e2e.admin, first);

    const res = await activate(stranger.client, pending);

    expect(res.status).toBe(404);
    expect(res.body).toEqual(notFound);
    expect((await grantOk(owner.client, pending)).status).toBe('pending');
    expect(await auditFor(e2e, 'promo.bonus.activated', pending)).toEqual([]);
  });

  it('the balance read returns real and bonus balances separately per currency', async () => {
    const player = await newBonusPlayer(e2e);
    const other = await newBonusPlayer(e2e);
    await fundPlayer(e2e, player, '40');
    await vi.waitFor(async () =>
      expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('40')),
    );
    await directGrant(e2e, player.userId, player.currency, { amount: '10' });
    await directGrant(e2e, player.userId, other.currency, { amount: '7' });

    const balances = await bonusBalances(player.client);

    const own = balances.find((b) => b.currency === player.currency);
    const foreign = balances.find((b) => b.currency === other.currency);
    expect(own).toMatchObject({
      bonus: money('10'),
      activeGrants: 1,
      wageringRequired: money('100'),
    });
    expect(foreign).toMatchObject({ bonus: money('7'), activeGrants: 1 });
    expect(balances).toHaveLength(2);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('40'));
    expect(await balanceOf(e2e, player.userId, other.currency)).toBe('0');
  });
});

describe('admin manages offers, weights and forfeits', () => {
  it('an admin creates an offer with unique key and terms and the creation is audited', async () => {
    const staff = await newStaff(e2e.app, 'bonus-admin', 'super-admin');
    const player = await newBonusPlayer(e2e);
    const key = uniqueKey();

    const res = await staff.client.post(
      '/backoffice/promo/offers',
      offerBody(player.currency, {
        key,
        matchPercent: '75',
        maxGrantAmount: '500',
        minDeposit: '20',
        terms: { wageringMultiplier: '15', expiryDays: 10, maxBet: '5' },
      }),
    );

    expect(res.status).toBe(200);
    const created = PromoOfferSchema.parse(await bodyOf(res));
    expect(created).toMatchObject({ key, status: 'active', currency: player.currency });
    expect(created.terms).toMatchObject({ wageringMultiplier: '15', expiryDays: 10 });
    const [row] = await dbOf(e2e).select().from(promoOffer).where(eq(promoOffer.id, created.id));
    expect(row).toMatchObject({
      key,
      matchPercent: '75.00',
      maxGrantAmount: money('500'),
      minDeposit: money('20'),
    });
    const audit = await auditFor(e2e, 'promo.offer.created', created.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: staff.userId,
      actorType: 'admin',
      resourceType: 'promo_offer',
    });
    expect(audit[0]?.after).toMatchObject({ key, currency: player.currency });
  });

  it('creating an offer with a key already in use is refused with a conflict', async () => {
    const player = await newBonusPlayer(e2e);
    const original = await createOffer(e2e.admin, player.currency, { name: 'Original name' });

    const res = await e2e.admin.post(
      '/backoffice/promo/offers',
      offerBody(player.currency, { key: original.key, name: 'Impostor' }),
    );

    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual(conflict);
    const rows = await dbOf(e2e).select().from(promoOffer).where(eq(promoOffer.key, original.key));
    expect(rows).toEqual([expect.objectContaining({ id: original.id, name: 'Original name' })]);
    expect(await auditFor(e2e, 'promo.offer.created', original.id)).toHaveLength(1);
  });

  it.todo(
    'GAP: updating the terms of an offer that already has grants is not refused, only a currency change is (promo/bonus/service/offer.service.ts:136-152)',
  );

  it('changing the currency of an offer players have opted in to is refused as claimed', async () => {
    const player = await newBonusPlayer(e2e);
    const elsewhere = await newBonusPlayer(e2e);
    const offer = await createOffer(e2e.admin, player.currency);
    await optInOk(player.client, offer.id);

    const res = await e2e.admin.patch(`/backoffice/promo/offers/${offer.id}`, {
      currency: elsewhere.currency,
    });

    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual(conflict);
    const [row] = await dbOf(e2e).select().from(promoOffer).where(eq(promoOffer.id, offer.id));
    expect(row?.currency).toBe(player.currency);
    expect(await auditFor(e2e, 'promo.offer.updated', offer.id)).toEqual([]);
  });

  it('an offer with contradictory max bet terms is refused as invalid terms', async () => {
    const player = await newBonusPlayer(e2e);
    const bothLimits = offerBody(player.currency, {
      terms: { maxBet: '5', maxBetRate: '0.5' },
    });
    const floorAboveCeiling = offerBody(player.currency, {
      terms: { maxBetRate: '0.5', maxBetFloor: '20', maxBetCeiling: '10' },
    });
    const existing = await createOffer(e2e.admin, player.currency, { terms: { maxBet: '5' } });

    for (const body of [bothLimits, floorAboveCeiling]) {
      const res = await e2e.admin.post('/backoffice/promo/offers', body);
      expect(res.status).toBe(422);
      expect(await dbOf(e2e).select().from(promoOffer).where(eq(promoOffer.key, body.key))).toEqual(
        [],
      );
    }
    const patched = await e2e.admin.patch(`/backoffice/promo/offers/${existing.id}`, {
      terms: { wageringMultiplier: '10', expiryDays: 30, maxBet: '5', maxBetRate: '0.5' },
    });
    expect(patched.status).toBe(422);
    const [row] = await dbOf(e2e).select().from(promoOffer).where(eq(promoOffer.id, existing.id));
    expect(row?.terms).toEqual({ wageringMultiplier: '10', expiryDays: 30, maxBet: '5' });
  });

  it('a weight profile edit applies to grants made afterwards and a grant keeps the weights it was made with', async () => {
    const early = await newBonusPlayer(e2e);
    const late = await newBonusPlayer(e2e);
    const gameId = `slots-${randomUUID()}`;
    const profileId = await createWeightProfile(e2e.admin, [
      { scope: 'game', scopeRef: gameId, contributionPercent: '50' },
      { scope: 'default', scopeRef: null, contributionPercent: '100' },
    ]);
    const terms = { wageringMultiplier: '10', expiryDays: 30, weightProfileId: profileId };
    const earlyGrant = await directGrant(e2e, early.userId, early.currency, {
      amount: '100',
      terms,
    });
    await fundPlayer(e2e, early, '300');
    await vi.waitFor(async () =>
      expect(await balanceOf(e2e, early.userId, early.currency)).toBe(money('300')),
    );

    const firstRound = randomUUID();
    await placeBet(e2e, early.userId, early.currency, '100', gameId, firstRound);
    await loseRound(e2e, early.userId, early.currency, firstRound);
    const [afterFirst] = await dbOf(e2e)
      .select()
      .from(promoGrant)
      .where(eq(promoGrant.id, earlyGrant));
    expect(afterFirst?.wageringProgress).toBe(money('50'));

    await setWeights(e2e.admin, profileId, [
      { scope: 'game', scopeRef: gameId, contributionPercent: '10' },
      { scope: 'default', scopeRef: null, contributionPercent: '100' },
    ]);
    const lateGrant = await directGrant(e2e, late.userId, late.currency, { amount: '100', terms });
    await fundPlayer(e2e, late, '300');
    await vi.waitFor(async () =>
      expect(await balanceOf(e2e, late.userId, late.currency)).toBe(money('300')),
    );

    const earlyRound = randomUUID();
    const lateRound = randomUUID();
    await placeBet(e2e, early.userId, early.currency, '100', gameId, earlyRound);
    await placeBet(e2e, late.userId, late.currency, '100', gameId, lateRound);
    await loseRound(e2e, early.userId, early.currency, earlyRound);
    await loseRound(e2e, late.userId, late.currency, lateRound);

    const [earlyRow] = await dbOf(e2e)
      .select()
      .from(promoGrant)
      .where(eq(promoGrant.id, earlyGrant));
    const [lateRow] = await dbOf(e2e).select().from(promoGrant).where(eq(promoGrant.id, lateGrant));
    expect(earlyRow?.wageringProgress).toBe(money('100'));
    expect(lateRow?.wageringProgress).toBe(money('10'));
  });

  it('a bet above the grant max bet is refused and moves no funds or wagering progress', async () => {
    const player = await newBonusPlayer(e2e);
    const grantId = await directGrant(e2e, player.userId, player.currency, {
      amount: '20',
      terms: { wageringMultiplier: '10', expiryDays: 30, maxBet: '5' },
    });
    await fundPlayer(e2e, player, '40');
    await vi.waitFor(async () =>
      expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('40')),
    );

    await expect(placeBet(e2e, player.userId, player.currency, '6')).rejects.toBeInstanceOf(
      MaxBetExceededError,
    );

    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('40'));
    const [untouched] = await dbOf(e2e).select().from(promoGrant).where(eq(promoGrant.id, grantId));
    expect(untouched).toMatchObject({ wageringProgress: money('0'), bonusBalance: money('20') });
    expect(await entryRows(e2e, grantId)).toHaveLength(1);

    const allowedRound = randomUUID();
    const allowed = await placeBet(
      e2e,
      player.userId,
      player.currency,
      '5',
      'game-1',
      allowedRound,
    );
    await loseRound(e2e, player.userId, player.currency, allowedRound);

    expect(allowed).toMatchObject({ ok: true, moved: true });
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('35'));
    const [progressed] = await dbOf(e2e)
      .select()
      .from(promoGrant)
      .where(eq(promoGrant.id, grantId));
    expect(progressed?.wageringProgress).toBe(money('5'));
  });

  it('a repeated bet with the same round id adds one wagering entry and one debit', async () => {
    const player = await newBonusPlayer(e2e);
    const grantId = await directGrant(e2e, player.userId, player.currency, { amount: '20' });
    await fundPlayer(e2e, player, '40');
    await vi.waitFor(async () =>
      expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('40')),
    );
    const roundId = randomUUID();

    await placeBet(e2e, player.userId, player.currency, '10', 'game-1', roundId);
    const replay = await placeBet(e2e, player.userId, player.currency, '10', 'game-1', roundId);

    await loseRound(e2e, player.userId, player.currency, roundId);

    expect(replay).toMatchObject({ ok: true, moved: false });
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('30'));
    const [row] = await dbOf(e2e).select().from(promoGrant).where(eq(promoGrant.id, grantId));
    expect(row?.wageringProgress).toBe(money('10'));
    const stakes = (await entryRows(e2e, grantId)).filter((entry) => entry.type === 'stake');
    expect(stakes).toHaveLength(1);
  });

  it('an admin forfeits an active grant, the bonus balance is removed and the forfeit is audited', async () => {
    const staff = await newStaff(e2e.app, 'bonus-support', 'admin');
    const player = await newBonusPlayer(e2e);
    const grantId = await directGrant(e2e, player.userId, player.currency, { amount: '20' });
    const note = 'forfeited after a bonus abuse review';

    const res = await staff.client.post(`/backoffice/promo/grants/${grantId}/forfeit`, { note });

    expect(res.status).toBe(200);
    const body = parseAdminGrant(await bodyOf(res));
    expect(body).toMatchObject({
      id: grantId,
      status: 'forfeited',
      forfeitReason: 'admin',
      forfeitNote: note,
      bonusBalance: money('0'),
      closedAmount: money('20'),
    });
    expect(body.forfeitedBy).toMatchObject({ id: staff.userId });
    const [row] = await dbOf(e2e).select().from(promoGrant).where(eq(promoGrant.id, grantId));
    expect(row).toMatchObject({
      status: 'forfeited',
      bonusBalance: money('0'),
      forfeitedBy: staff.userId,
    });
    const entries = await entryRows(e2e, grantId);
    expect(entries.map((e) => [e.type, e.bonusAmount, e.balanceAfter])).toEqual([
      ['grant', money('20'), money('20')],
      ['forfeit', `-${money('20')}`, money('0')],
    ]);
    const balances = await bonusBalances(player.client);
    expect(balances.find((b) => b.currency === player.currency)?.bonus ?? '0').toMatch(
      /^0(\.0+)?$/,
    );
    expect((await grantEntries(player.client, grantId)).map((e) => e.type).sort()).toEqual([
      'forfeit',
      'grant',
    ]);
    const audit = await auditFor(e2e, 'promo.bonus.forfeited', grantId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: staff.userId, actorType: 'admin' });
    expect(audit[0]?.after).toMatchObject({
      userId: player.userId,
      status: 'forfeited',
      reason: 'admin',
      note,
    });
  });

  it('forfeiting a grant that is already closed is refused with a conflict and leaves balances unchanged', async () => {
    const player = await newBonusPlayer(e2e);
    const grantId = await directGrant(e2e, player.userId, player.currency, { amount: '20' });
    await fundPlayer(e2e, player, '40');
    await vi.waitFor(async () =>
      expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('40')),
    );
    expect((await forfeit(e2e.admin, grantId)).status).toBe(200);

    const again = await forfeit(e2e.admin, grantId, 'second forfeit attempt');
    const unknown = await forfeit(e2e.admin, randomUUID());

    expect(again.status).toBe(409);
    expect(again.body).toEqual(conflict);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(notFound);
    const entries = await entryRows(e2e, grantId);
    expect(entries.map((e) => e.type)).toEqual(['grant', 'forfeit']);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('40'));
    const [row] = await dbOf(e2e).select().from(promoGrant).where(eq(promoGrant.id, grantId));
    expect(row).toMatchObject({
      status: 'forfeited',
      bonusBalance: money('0'),
      forfeitNote: 'e2e forfeit for a test case',
    });
    expect(await auditFor(e2e, 'promo.bonus.forfeited', grantId)).toHaveLength(1);
    expect(await auditFor(e2e, 'promo.bonus.forfeit_refused', grantId)).toHaveLength(1);
    expect(
      await dbOf(e2e).select().from(promoGrantEntry).where(eq(promoGrantEntry.grantId, grantId)),
    ).toHaveLength(2);
  });

  it('a non-admin calling any admin offer, weight or grant route is refused as forbidden', async () => {
    const player = await newBonusPlayer(e2e);
    const offer = await createOffer(e2e.admin, player.currency);
    const grantId = await directGrant(e2e, player.userId, player.currency);
    const profileId = await createWeightProfile(e2e.admin, [
      { scope: 'default', scopeRef: null, contributionPercent: '100' },
    ]);
    const key = uniqueKey();
    const calls: [string, string, unknown?][] = [
      ['get', '/backoffice/promo/offers'],
      ['post', '/backoffice/promo/offers', offerBody(player.currency, { key })],
      ['patch', `/backoffice/promo/offers/${offer.id}`, { name: 'Hijacked' }],
      ['get', '/backoffice/promo/weight-profiles'],
      ['post', '/backoffice/promo/weight-profiles', { name: `intruder-${randomUUID()}` }],
      [
        'put',
        `/backoffice/promo/weight-profiles/${profileId}/weights`,
        { weights: [{ scope: 'default', scopeRef: null, contributionPercent: '0' }] },
      ],
      ['get', `/backoffice/promo/players/${player.userId}/grants`],
      [
        'post',
        `/backoffice/promo/grants/${grantId}/forfeit`,
        { note: 'player forfeits own bonus' },
      ],
    ];

    for (const [method, path, body] of calls) {
      const res =
        method === 'get'
          ? await player.client.get(path)
          : method === 'patch'
            ? await player.client.patch(path, body)
            : method === 'put'
              ? await player.client.put(path, body)
              : await player.client.post(path, body);
      expect([path, res.status]).toEqual([path, 403]);
    }

    const accountant = await newStaff(e2e.app, 'bonus-finance', 'finance-accounting');
    const noForfeit = await accountant.client.post(`/backoffice/promo/grants/${grantId}/forfeit`, {
      note: 'finance may not forfeit bonuses',
    });
    expect(noForfeit.status).toBe(403);
    const support = await newStaff(e2e.app, 'bonus-support', 'admin');
    const noCreate = await support.client.post(
      '/backoffice/promo/offers',
      offerBody(player.currency, { key }),
    );
    expect(noCreate.status).toBe(403);

    expect(await dbOf(e2e).select().from(promoOffer).where(eq(promoOffer.key, key))).toEqual([]);
    const [offerRow] = await dbOf(e2e).select().from(promoOffer).where(eq(promoOffer.id, offer.id));
    expect(offerRow?.name).toBe('E2E welcome bonus');
    const [grantRow] = await dbOf(e2e).select().from(promoGrant).where(eq(promoGrant.id, grantId));
    expect(grantRow).toMatchObject({ status: 'active', bonusBalance: money('20') });
  });
});

describe('admin sets how bets contribute', () => {
  const weights = [{ scope: 'default', scopeRef: null, contributionPercent: '100' }];
  const createProfile = async (body: Record<string, unknown> = {}) => {
    const res = await e2e.admin.post('/backoffice/promo/weight-profiles', {
      name: `contribution-${randomUUID()}`,
      ...body,
    });
    return z
      .object({ id: z.string() })
      .loose()
      .parse(await bodyOf(res));
  };
  const saveWeights = (id: string, body: Record<string, unknown>) =>
    e2e.admin.put(`/backoffice/promo/weight-profiles/${id}/weights`, { weights, ...body });

  it('creates a flat profile at version 1 when no mode is named', async () => {
    const created = await createProfile();

    expect(created).toMatchObject({ contributionMode: 'flat', referenceEdge: null, version: 1 });
  });

  it('switches a profile to house edge, bumps its version and audits both sides', async () => {
    const created = await createProfile();

    const res = await saveWeights(created.id, {
      contributionMode: 'house_edge',
      referenceEdge: '0.04',
    });

    expect(res.status).toBe(200);
    const saved = z
      .object({ referenceEdge: z.string() })
      .loose()
      .parse(await bodyOf(res));
    expect(saved).toMatchObject({ contributionMode: 'house_edge', version: 2 });
    expect(Number(saved.referenceEdge)).toBe(0.04);
    const rows = await auditFor(e2e, 'promo.weight_profile.set', created.id);
    const latest = rows.at(-1);
    expect(latest?.before).toMatchObject({
      contributionMode: 'flat',
      referenceEdge: null,
      version: 1,
    });
    expect(latest?.after).toMatchObject({ contributionMode: 'house_edge', version: 2 });
  });

  it('refuses house edge without a reference edge and leaves the profile as it was', async () => {
    const created = await createProfile();

    const res = await saveWeights(created.id, { contributionMode: 'house_edge' });

    expect(res.status).toBe(400);
    const listed = z
      .array(z.object({ id: z.string() }).loose())
      .parse(await bodyOf(await e2e.admin.get('/backoffice/promo/weight-profiles')));
    expect(listed.find((p) => p.id === created.id)).toMatchObject({
      contributionMode: 'flat',
      version: 1,
    });
  });

  it('keeps the mode when a save names no contribution', async () => {
    const created = await createProfile({ contributionMode: 'house_edge', referenceEdge: '0.04' });

    const saved = z
      .object({ referenceEdge: z.string() })
      .loose()
      .parse(await bodyOf(await saveWeights(created.id, {})));

    expect(saved).toMatchObject({ contributionMode: 'house_edge', version: 2 });
    expect(Number(saved.referenceEdge)).toBe(0.04);
  });
});

describe('admin limits the buckets a bet class may use', () => {
  const funds = (betClassBuckets?: BonusFundSettings['betClassBuckets']) => ({
    terms: {
      wageringMultiplier: '5',
      expiryDays: 30,
      funds: {
        rolloverBase: 'bonus' as const,
        existingBalance: 'free' as const,
        freeFundsOrder: 'first' as const,
        dustThresholdUsd: '0.01',
        decimals: 2,
        ...(betClassBuckets ? { betClassBuckets } : {}),
      },
    },
  });
  const createWithFunds = async (betClassBuckets?: BonusFundSettings['betClassBuckets']) => {
    const res = await e2e.admin.post(
      '/backoffice/promo/offers',
      offerBody('USD', { key: uniqueKey(), ...funds(betClassBuckets) }),
    );
    return PromoOfferSchema.parse(await bodyOf(res));
  };

  it('stores the class rules on create and on patch', async () => {
    const offer = await createWithFunds({ zero: ['unlinked', 'linked'] });
    expect(offer.terms.funds?.betClassBuckets).toEqual({ zero: ['unlinked', 'linked'] });

    const patched = PromoOfferSchema.parse(
      await bodyOf(
        await e2e.admin.patch(`/backoffice/promo/offers/${offer.id}`, funds({ pvp: ['unlinked'] })),
      ),
    );

    expect(patched.terms.funds?.betClassBuckets).toEqual({ pvp: ['unlinked'] });
  });

  it('stores no class rules when none are given', async () => {
    const offer = await createWithFunds();

    expect(offer.terms.funds).not.toHaveProperty('betClassBuckets');
  });
});

describe('player forfeits their own bonus', () => {
  const forfeitable = async (allowPlayerForfeit?: boolean) => {
    const player = await newBonusPlayer(e2e);
    const grantId = await directGrant(e2e, player.userId, player.currency, {
      amount: '50',
      buckets: { linked: '50', unlinked: '10' },
      terms: {
        wageringMultiplier: '5',
        expiryDays: 30,
        ...(allowPlayerForfeit === undefined ? {} : { allowPlayerForfeit }),
      },
    });
    return { player, grantId };
  };

  it('forfeits it where the terms allow, removing the bonus and releasing the linked cash', async () => {
    const { player, grantId } = await forfeitable(true);
    expect((await getGrant(player.client, grantId)).body).toMatchObject({
      playerForfeitable: true,
    });

    const res = await player.client.post(`/promo/grants/${grantId}/forfeit`, {});

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({
      id: grantId,
      status: 'forfeited',
      forfeitReason: 'player_opt_out',
      bonusBalance: money('0'),
      linkedCash: money('0'),
      unlinkedCash: money('0'),
    });
  });

  it('is refused where the terms do not allow it, and the bonus stays live', async () => {
    const { player, grantId } = await forfeitable();

    const res = await player.client.post(`/promo/grants/${grantId}/forfeit`, {});

    expect(res.status).toBe(403);
    expect((await getGrant(player.client, grantId)).body).toMatchObject({
      status: 'active',
      playerForfeitable: false,
    });
  });

  it("cannot forfeit another player's bonus, and is told it does not exist", async () => {
    const { player: owner, grantId } = await forfeitable(true);
    const stranger = await newBonusPlayer(e2e);

    const res = await stranger.client.post(`/promo/grants/${grantId}/forfeit`, {});

    expect(res.status).toBe(404);
    expect((await getGrant(owner.client, grantId)).body).toMatchObject({ status: 'active' });
  });

  it('cannot forfeit a bonus twice', async () => {
    const { player, grantId } = await forfeitable(true);
    await player.client.post(`/promo/grants/${grantId}/forfeit`, {});

    const res = await player.client.post(`/promo/grants/${grantId}/forfeit`, {});

    expect(res.status).toBe(409);
  });
});

describe('a bet against a bonus counts when its round settles', () => {
  async function bettor(cash: string, bonus: string, multiplier: string) {
    const player = await newBonusPlayer(e2e);
    const grantId = await directGrant(e2e, player.userId, player.currency, {
      amount: bonus,
      terms: { wageringMultiplier: multiplier, expiryDays: 30 },
    });
    await fundPlayer(e2e, player, cash);
    await vi.waitFor(async () =>
      expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money(cash)),
    );
    return { player, grantId };
  }
  const progressOf = async (grantId: string) => {
    const [row] = await dbOf(e2e).select().from(promoGrant).where(eq(promoGrant.id, grantId));
    return row;
  };

  it('shows an open round as pending on the player and staff reads, then as progress once it settles', async () => {
    const { player, grantId } = await bettor('100', '100', '10');
    const reads = async () => {
      const own = await grantOk(player.client, grantId);
      const staff = await e2e.admin.get(`/backoffice/promo/players/${player.userId}/grants`);
      const listed = z
        .array(
          z.object({ id: z.string(), pendingWagered: z.string(), wageringProgress: z.string() }),
        )
        .parse(await bodyOf(staff))
        .find((g) => g.id === grantId);
      return [
        own.pendingWagered,
        own.wageringProgress,
        listed?.pendingWagered,
        listed?.wageringProgress,
      ];
    };
    const round = randomUUID();

    expect(await reads()).toEqual([money('0'), money('0'), money('0'), money('0')]);
    await placeBet(e2e, player.userId, player.currency, '40', 'game-1', round);
    expect(await reads()).toEqual([money('40'), money('0'), money('40'), money('0')]);
    await loseRound(e2e, player.userId, player.currency, round);
    expect(await reads()).toEqual([money('0'), money('40'), money('0'), money('40')]);
  });

  it('records a progress entry the player sees once the round settles', async () => {
    const { player, grantId } = await bettor('100', '100', '10');
    const round = randomUUID();
    await placeBet(e2e, player.userId, player.currency, '40', 'game-1', round);
    await loseRound(e2e, player.userId, player.currency, round);

    const entries = await grantEntries(player.client, grantId);

    const progress = entries.filter((e) => e.type === 'progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ bonusAmount: money('0'), wageringDelta: money('40') });
  });

  it('keeps a round open after a partial reversal, crediting its progress only when the rest settles', async () => {
    const { player, grantId } = await bettor('100', '100', '10');
    const round = randomUUID();
    await placeBet(e2e, player.userId, player.currency, '100', 'game-1', round);

    await reverseBet(e2e, player.userId, player.currency, '20', round);

    expect(await grantOk(player.client, grantId)).toMatchObject({
      pendingWagered: money('80'),
      wageringProgress: money('0'),
      status: 'active',
    });
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('20'));

    await loseRound(e2e, player.userId, player.currency, round);

    expect(await grantOk(player.client, grantId)).toMatchObject({
      pendingWagered: money('0'),
      wageringProgress: money('80'),
      status: 'active',
    });
  });

  it('converts what is left to the real balance and closes the grant only once the round settles', async () => {
    const { player, grantId } = await bettor('200', '100', '1');
    const round = randomUUID();
    await placeBet(e2e, player.userId, player.currency, '100', 'game-1', round);
    expect((await progressOf(grantId))?.status).toBe('active');

    await loseRound(e2e, player.userId, player.currency, round);

    expect(await progressOf(grantId)).toMatchObject({
      status: 'completed',
      bonusBalance: money('0'),
      wageringProgress: money('100'),
    });
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('200'));
    expect((await entryRows(e2e, grantId)).map((e) => e.type).sort()).toEqual([
      'convert',
      'grant',
      'progress',
      'stake',
    ]);
  });

  it('takes back the progress a bet bought when the round is voided before it settles', async () => {
    const { player, grantId } = await bettor('100', '100', '10');
    const round = randomUUID();
    await placeBet(e2e, player.userId, player.currency, '40', 'game-1', round);

    await reverseBet(e2e, player.userId, player.currency, '40', round);

    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(money('100'));
    expect(await progressOf(grantId)).toMatchObject({
      wageringProgress: money('0'),
      bonusBalance: money('100'),
    });
  });
});

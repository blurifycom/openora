import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { BonusGrantTerms, WagerProduct } from '@openora/core/contracts';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { promoWeight, promoWeightProfile } from '../schema/index.js';
import { GrantService } from '../service/grant.service.js';
import { WageringService } from '../service/wagering.service.js';

let db: TestDb;
let weightProfileId: string;

beforeAll(async () => {
  db = await createTestDb([migrate]);
  weightProfileId = findOneOrThrow(
    await db.drizzle.db
      .insert(promoWeightProfile)
      .values({ name: `profile-${randomUUID()}` })
      .returning(),
    new Error('seed profile: query returned no row'),
  ).id;
  await db.drizzle.db.insert(promoWeight).values({
    profileId: weightProfileId,
    scope: 'default',
    scopeRef: null,
    contributionPercent: '100',
  });
});

afterAll(async () => {
  await db.drop();
});

const grantFor = async (
  userId: string,
  amount: string,
  limit: Partial<BonusGrantTerms> = { maxBet: '10' },
) => {
  const outcome = await db.drizzle.db.transaction((tx) =>
    new GrantService(makeAuditWriter()).grant(tx, {
      userId,
      currency: 'USD',
      amount,
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      terms: { wageringMultiplier: '50', expiryDays: 30, weightProfileId, ...limit },
    }),
  );
  if (!outcome.ok) {
    throw new Error('grant was refused');
  }
  return outcome.grantId;
};

const stake = (
  userId: string,
  amount: string,
  round: string,
  product: WagerProduct = 'casino',
  providerName = 'aggregator',
) =>
  db.drizzle.db.transaction((tx) =>
    new WageringService(makeAuditWriter()).wager(tx, {
      userId,
      currency: 'USD',
      stake: amount,
      realAvailable: '1000000',
      context: { provider: 'aggregator', product },
      providerName,
      externalRoundId: round,
    }),
  );

const reversal = (userId: string, amount: string, round: string) =>
  db.drizzle.db.transaction((tx) =>
    new WageringService(makeAuditWriter()).settle(tx, {
      userId,
      currency: 'USD',
      amount,
      kind: 'bet_reversal',
      providerName: 'aggregator',
      externalRoundId: round,
      realBalance: '1000000',
    }),
  );

const refusedAt = (outcome: Awaited<ReturnType<typeof stake>>) =>
  !outcome.ok && outcome.reason === 'max_bet_exceeded'
    ? { maxBet: Number(outcome.maxBet), roundStake: Number(outcome.roundStake) }
    : null;

describe('wager() against the grant max bet', () => {
  it('refuses a debit that takes the round total over the limit', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100');
    const round = randomUUID();

    expect(await stake(userId, '6', round)).toMatchObject({ ok: true });
    expect(await stake(userId, '4', round)).toMatchObject({ ok: true });
    expect(refusedAt(await stake(userId, '0.01', round))).toEqual({
      maxBet: 10,
      roundStake: 10.01,
    });
  });

  it('allows a round total exactly at the limit', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100');
    const round = randomUUID();

    await stake(userId, '3', round);

    expect(await stake(userId, '7', round)).toMatchObject({ ok: true });
  });

  it('does not add one round to another', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100');

    await stake(userId, '10', randomUUID());

    expect(await stake(userId, '10', randomUUID())).toMatchObject({ ok: true });
  });

  it('does not add a different provider that minted the same round id', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100');
    const round = randomUUID();

    await stake(userId, '10', round, 'casino', 'other-aggregator');

    expect(await stake(userId, '10', round)).toMatchObject({ ok: true });
  });

  it('takes a reversed stake back out of the round total', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100');
    const round = randomUUID();

    await stake(userId, '8', round);
    await reversal(userId, '8', round);

    expect(await stake(userId, '10', round)).toMatchObject({ ok: true });
  });

  it('refuses a single stake over the limit, which is also its round total', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100');

    expect(refusedAt(await stake(userId, '10.01', randomUUID()))).toEqual({
      maxBet: 10,
      roundStake: 10.01,
    });
  });

  it('enforces the limit resolved from the rate, floor and ceiling at grant time', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100', { maxBetRate: '0.01', maxBetFloor: '5', maxBetCeiling: '50' });

    expect(await stake(userId, '5', randomUUID())).toMatchObject({ ok: true });
    expect(refusedAt(await stake(userId, '5.01', randomUUID()))).toEqual({
      maxBet: 5,
      roundStake: 5.01,
    });
  });

  it('skips a zero stake, which a provider free spin reports', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100');
    const round = randomUUID();
    await stake(userId, '10', round);

    expect(await stake(userId, '0', round)).toMatchObject({ ok: true });
  });

  it('does not count a zero stake toward the round total', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100');
    const round = randomUUID();

    await stake(userId, '0', round);

    expect(await stake(userId, '10', round)).toMatchObject({ ok: true });
  });

  it('never limits a product the grant exempts, however large the round', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100', { maxBet: '10', maxBetExemptProducts: ['pvp'] });
    const round = randomUUID();

    expect(await stake(userId, '500', round, 'pvp')).toMatchObject({ ok: true });
    expect(await stake(userId, '500', round, 'pvp')).toMatchObject({ ok: true });
  });

  it('still limits a product the grant does not exempt', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100', { maxBet: '10', maxBetExemptProducts: ['pvp'] });

    expect(refusedAt(await stake(userId, '11', randomUUID(), 'casino'))).not.toBeNull();
  });

  it('places no limit on a grant with no rate and no max bet', async () => {
    const userId = randomUUID();
    await grantFor(userId, '100', { maxBetFloor: '1', maxBetCeiling: '2' });

    expect(await stake(userId, '1000', randomUUID())).toMatchObject({ ok: true });
  });

  it('places no limit on a player with no active grant', async () => {
    expect(await stake(randomUUID(), '1000', randomUUID())).toMatchObject({
      ok: true,
      grantId: null,
    });
  });
});

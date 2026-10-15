import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { WagerContext, WagerTrackingCommands } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { WageringService } from '../service/wagering.service.js';
import { promoGrant } from '../schema/index.js';

let db: TestDb;

const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

describe('wager() with no attributed bonus grant', () => {
  it('still reports the bet to wager tracking at its full stake', async () => {
    const wagerTracking: WagerTrackingCommands = { recordWager: vi.fn(async () => []) };
    const wagering = new WageringService(wagerTracking);
    const userId = randomUUID();

    const outcome = await db.drizzle.db.transaction((tx) =>
      wagering.wager(tx, {
        userId,
        currency: 'USD',
        stake: '25',
        fromBonus: '0',
        context: CASINO,
        providerName: 'dice',
        externalRoundId: randomUUID(),
      }),
    );

    expect(outcome).toMatchObject({ ok: true, grantId: null });
    expect(wagerTracking.recordWager).toHaveBeenCalledTimes(1);
    expect(wagerTracking.recordWager).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId, currency: 'USD', amount: '25', weightedAmount: '25' }),
    );
  });

  it('takes a rolled-back cash round back out of wager tracking', async () => {
    const wagerTracking: WagerTrackingCommands = {
      recordWager: vi.fn(async () => []),
      reverseWager: vi.fn(async () => {}),
    };
    const wagering = new WageringService(wagerTracking);
    const userId = randomUUID();
    const round = { providerName: 'dice', externalRoundId: randomUUID() };

    await db.drizzle.db.transaction(async (tx) => {
      await wagering.wager(tx, {
        userId,
        currency: 'USD',
        stake: '25',
        fromBonus: '0',
        context: CASINO,
        ...round,
      });
      await wagering.settle(tx, {
        userId,
        currency: 'USD',
        amount: '25',
        kind: 'bet_reversal',
        ...round,
      });
    });

    expect(wagerTracking.recordWager).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ round }),
    );
    expect(wagerTracking.reverseWager).toHaveBeenCalledWith(expect.anything(), {
      userId,
      currency: 'USD',
      round,
      realAmount: '25',
    });
  });

  it('reports a real-money-only stake at its full stake, all of it real, leaving an active grant untouched', async () => {
    const wagerTracking: WagerTrackingCommands = { recordWager: vi.fn(async () => []) };
    const wagering = new WageringService(wagerTracking);
    const userId = randomUUID();
    const [grant] = await db.drizzle.db
      .insert(promoGrant)
      .values({
        userId,
        currency: 'USD',
        source: 'manual',
        sourceRef: randomUUID(),
        terms: { wageringMultiplier: '5', expiryDays: 30, maxBet: '5', weights: [] },
        grantedAmount: '10',
        bonusBalance: '10',
        wageringRequired: '50',
        expiresAt: new Date(Date.now() + 86_400_000),
        activatedAt: new Date(),
      })
      .returning();

    const outcome = await db.drizzle.db.transaction((tx) =>
      wagering.wager(tx, {
        userId,
        currency: 'USD',
        stake: '25',
        fromBonus: '0',
        context: { provider: 'sportsbook', product: 'sportsbook' },
        providerName: 'sportsbook',
        externalRoundId: randomUUID(),
      }),
    );

    expect(outcome).toMatchObject({ ok: true, grantId: null, bonusSpent: '0' });
    expect(wagerTracking.recordWager).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: '25', weightedAmount: '25', realAmount: '25' }),
    );
    const [after] = await db.drizzle.db
      .select()
      .from(promoGrant)
      .where(eq(promoGrant.id, grant!.id));
    expect(after).toMatchObject({
      bonusBalance: '10.000000000000000000',
      wageringProgress: '0.000000000000000000',
      status: 'active',
    });
  });

  it('does not report a bet requesting bonus funds it has no grant for', async () => {
    const wagerTracking: WagerTrackingCommands = { recordWager: vi.fn(async () => []) };
    const wagering = new WageringService(wagerTracking);

    const outcome = await db.drizzle.db.transaction((tx) =>
      wagering.wager(tx, {
        userId: randomUUID(),
        currency: 'USD',
        stake: '25',
        fromBonus: '10',
        context: CASINO,
        providerName: 'dice',
        externalRoundId: randomUUID(),
      }),
    );

    expect(outcome).toMatchObject({ ok: false, reason: 'insufficient_bonus' });
    expect(wagerTracking.recordWager).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { WagerContext, WagerTrackingCommands } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { WageringService } from '../service/wagering.service.js';

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
    const wagerTracking: WagerTrackingCommands = { recordWager: vi.fn(async () => {}) };
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

  it('does not report a bet requesting bonus funds it has no grant for', async () => {
    const wagerTracking: WagerTrackingCommands = { recordWager: vi.fn(async () => {}) };
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

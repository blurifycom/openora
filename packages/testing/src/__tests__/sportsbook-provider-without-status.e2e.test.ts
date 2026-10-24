import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { JOB_QUEUE } from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import { betting } from '@openora/core/sportsbook/contracts';
import {
  sportsbookBet,
  sportsbookReconciliationFinding,
} from '@openora/core/sportsbook/schema/betting';
import { closeE2e, type TestApp, type TestClient, type TestDb } from '../index.js';
import {
  acceptedBet,
  balanceOf,
  bootSportsbookApp,
  enableSportsbook,
  expectApplied,
  fundedPlayer,
  ledgerOf,
  reserveArgs,
} from './fixtures/sportsbook.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

beforeAll(async () => {
  ({ db, app } = await bootSportsbookApp({ provider: 'without-status' }));
  admin = await enableSportsbook(app);
}, 60_000);

afterAll(() => closeE2e({ app, db }));

const drizzle = () => app.container.get(DRIZZLE).db;

async function betRow(betId: string) {
  const [row] = await drizzle().select().from(sportsbookBet).where(eq(sportsbookBet.id, betId));
  return row!;
}

describe('a provider with no bet status lookup', () => {
  it('refuses an align as provider-unavailable and moves nothing', async () => {
    const player = await fundedPlayer(app, '100');
    const { betId } = await acceptedBet(app, player);
    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(res.status).toBe(503);
    expect(await betRow(betId)).toMatchObject({ status: 'accepted', version: 1 });
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
  });

  it('files a stale reserve as unresolved after the attempt budget', async () => {
    const player = await fundedPlayer(app, '100');
    const { betId } = expectApplied(await ledgerOf(app).reserve(reserveArgs(player.sessionId)));
    await drizzle()
      .update(sportsbookBet)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(sportsbookBet.id, betId!));

    for (let attempt = 1; attempt <= betting.SPORTSBOOK_RECONCILE_MAX_ATTEMPTS; attempt++) {
      await app.container.get(JOB_QUEUE).enqueue(betting.SPORTSBOOK_RECONCILE_QUEUE, {});
      await vi.waitFor(
        async () =>
          expect((await betRow(betId!)).reconcileAttempts).toBeGreaterThanOrEqual(attempt),
        { timeout: 15_000 },
      );
    }
    const kinds = await drizzle()
      .select({ kind: sportsbookReconciliationFinding.kind })
      .from(sportsbookReconciliationFinding)
      .where(eq(sportsbookReconciliationFinding.betId, betId!));
    expect(kinds.map((k) => k.kind)).toEqual(['reserve_unresolved']);
    expect(await betRow(betId!)).toMatchObject({ status: 'reserved' });
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
  });
});

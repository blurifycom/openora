import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import type { RunContext } from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { sportsbookBet, sportsbookSession } from '../schema/index.js';
import bettingPlugin from '../plugin.js';

let db: TestDb;

const RANGE = { dateFrom: '2026-01-01', dateTo: '2026-01-31' };
const AT = (iso: string) => new Date(iso);
const amount = (value: number) => expect.stringMatching(new RegExp(`^${value}(\\.0+)?$`));
const LEG = (eventName: string) => ({
  eventId: randomUUID(),
  eventName,
  market: 'Match winner',
  selection: 'Home',
  odds: '2.50',
  startsAt: '2026-12-01T18:00:00.000Z',
});

function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('betting');
  bettingPlugin.register(registry);
  return createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
}

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: randomUUID() },
  catalogVersion: 'test',
  correlationId: 'turnover-exposure-tool',
});

async function seedPlayer() {
  return findOneOrThrow(
    await db.drizzle.db.insert(player).values({ userId: randomUUID() }).returning(),
    new Error('seedPlayer: no row'),
  );
}

async function seedBet(
  userId: string,
  values: Partial<typeof sportsbookBet.$inferInsert> & {
    status: (typeof sportsbookBet.$inferInsert)['status'];
    stake: string;
    potentialPayout: string;
  },
) {
  const session = findOneOrThrow(
    await db.drizzle.db
      .insert(sportsbookSession)
      .values({
        userId,
        provider: 'book',
        currency: values.currency ?? 'USD',
        countryCode: 'MT',
        expiresAt: AT('2027-01-01T00:00:00.000Z'),
      })
      .returning(),
    new Error('seedBet: no session'),
  );
  return findOneOrThrow(
    await db.drizzle.db
      .insert(sportsbookBet)
      .values({
        userId,
        provider: 'book',
        providerBetId: randomUUID(),
        sessionId: session.id,
        currency: 'USD',
        currencyDecimals: 2,
        cashStake: values.stake,
        voidPayout: values.stake,
        legs: [LEG('Secret Derby')],
        lastLegStartsAt: AT('2026-12-01T18:00:00.000Z'),
        ...values,
      })
      .returning(),
    new Error('seedBet: no bet'),
  );
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${sportsbookBet}, ${sportsbookSession}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('sportsbook.turnover_exposure through the MCP kernel (real PG)', () => {
  it('sums the turnover of the range per currency and ranks the open bets by what they pay', async () => {
    const kernel = bootKernel();
    const [alice, bob] = [await seedPlayer(), await seedPlayer()];
    await seedBet(alice.userId, {
      status: 'settled',
      result: 'won',
      stake: '10',
      potentialPayout: '25',
      payoutTotal: '25',
      acceptedAt: AT('2026-01-10T10:00:00.000Z'),
      settledAt: AT('2026-01-12T10:00:00.000Z'),
    });
    const big = await seedBet(bob.userId, {
      status: 'accepted',
      stake: '20',
      potentialPayout: '100',
      legs: [LEG('Secret Derby'), LEG('Quiet Cup')],
      acceptedAt: AT('2026-01-15T10:00:00.000Z'),
    });
    await seedBet(alice.userId, {
      status: 'reserved',
      stake: '5',
      potentialPayout: '50',
      createdAt: AT('2026-01-20T10:00:00.000Z'),
    });
    // Accepted before the range: open now, so in the exposure, but not in the range's stakes.
    const old = await seedBet(bob.userId, {
      status: 'accepted',
      stake: '40',
      potentialPayout: '60',
      createdAt: AT('2025-12-01T10:00:00.000Z'),
      acceptedAt: AT('2025-12-01T10:00:00.000Z'),
    });
    // Staked before the range and lost in it: no stake, a zero payout.
    await seedBet(alice.userId, {
      status: 'settled',
      result: 'lost',
      stake: '30',
      potentialPayout: '90',
      acceptedAt: AT('2025-12-20T10:00:00.000Z'),
      settledAt: AT('2026-01-05T10:00:00.000Z'),
    });
    await seedBet(alice.userId, {
      status: 'cancelled',
      stake: '500',
      potentialPayout: '900',
      createdAt: AT('2026-01-08T10:00:00.000Z'),
      cancelledAt: AT('2026-01-08T10:01:00.000Z'),
    });
    await seedBet(bob.userId, {
      currency: 'EUR',
      status: 'settled',
      result: 'lost',
      stake: '7',
      potentialPayout: '14',
      acceptedAt: AT('2026-01-03T10:00:00.000Z'),
      settledAt: AT('2026-01-04T10:00:00.000Z'),
    });

    const result = await kernel.invokeTool(
      'sportsbook.turnover_exposure',
      { ...RANGE, largestOpen: 2 },
      runContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        ...RANGE,
        currencies: [
          expect.objectContaining({
            currency: 'EUR',
            bets: 1,
            stake: amount(7),
            payout: amount(0),
          }),
          {
            currency: 'USD',
            bets: 3,
            stake: amount(35),
            cashStake: amount(35),
            promotionStake: amount(0),
            payout: amount(25),
            cashPayout: amount(25),
            promotionPayout: amount(0),
            openBets: 3,
            openExposure: amount(65),
            openPotentialPayout: amount(210),
            largestOpen: [
              {
                betId: big.id,
                playerId: bob.id,
                status: 'accepted',
                stake: amount(20),
                potentialPayout: amount(100),
                legs: 2,
                placedAt: big.createdAt.toISOString(),
                lastLegStartsAt: '2026-12-01T18:00:00.000Z',
              },
              expect.objectContaining({ betId: old.id, playerId: bob.id }),
            ],
          },
        ],
        truncated: false,
      },
    });
    const served = JSON.stringify(result);
    expect(served).not.toContain('Secret Derby');
    expect(served).not.toContain(bob.userId);
  });

  it('narrows to one currency, can leave the open bets out, and refuses a range over 92 days', async () => {
    const kernel = bootKernel();
    const row = await seedPlayer();
    await seedBet(row.userId, {
      status: 'accepted',
      stake: '20',
      potentialPayout: '100',
      acceptedAt: AT('2026-01-15T10:00:00.000Z'),
    });
    await seedBet(row.userId, {
      currency: 'EUR',
      status: 'accepted',
      stake: '7',
      potentialPayout: '14',
      acceptedAt: AT('2026-01-15T10:00:00.000Z'),
    });

    expect(
      await kernel.invokeTool(
        'sportsbook.turnover_exposure',
        { ...RANGE, currency: 'eur', largestOpen: 0 },
        runContext(),
      ),
    ).toMatchObject({
      ok: true,
      output: { currencies: [{ currency: 'EUR', openBets: 1, largestOpen: [] }] },
    });
    for (const input of [{ dateFrom: '2026-01-01', dateTo: '2026-04-03' }, { largestOpen: 21 }]) {
      expect(
        await kernel.invokeTool('sportsbook.turnover_exposure', input, runContext()),
      ).toMatchObject({ ok: false, error: 'invalid_input' });
    }
  });
});

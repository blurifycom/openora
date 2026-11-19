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

const RANGE = { placedFrom: '2026-01-01', placedTo: '2026-01-31' };
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
  correlationId: 'bets-find-tool',
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

describe('sportsbook.bets_find through the MCP kernel (real PG)', () => {
  it('lists the bets placed in range by player id, newest first, without their selections', async () => {
    const kernel = bootKernel();
    const [alice, bob] = [await seedPlayer(), await seedPlayer()];
    const settled = await seedBet(alice.userId, {
      status: 'settled',
      result: 'won',
      stake: '10',
      potentialPayout: '25',
      payoutTotal: '25',
      createdAt: AT('2026-01-10T10:00:00.000Z'),
      acceptedAt: AT('2026-01-10T10:00:01.000Z'),
      settledAt: AT('2026-01-12T10:00:00.000Z'),
    });
    // The last instant of placedTo counts; the first of the next day does not.
    const open = await seedBet(bob.userId, {
      status: 'accepted',
      stake: '20',
      potentialPayout: '100',
      legs: [LEG('Secret Derby'), LEG('Quiet Cup')],
      createdAt: AT('2026-01-31T23:59:59.999Z'),
    });
    await seedBet(bob.userId, {
      status: 'accepted',
      stake: '99',
      potentialPayout: '999',
      createdAt: AT('2026-02-01T00:00:00.000Z'),
    });
    // A bet whose player has no profile row is still listed, by no player.
    const orphan = await seedBet(randomUUID(), {
      status: 'cancelled',
      stake: '5',
      potentialPayout: '9',
      createdAt: AT('2026-01-05T10:00:00.000Z'),
    });

    const result = await kernel.invokeTool('sportsbook.bets_find', RANGE, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        ...RANGE,
        total: 3,
        truncated: false,
        bets: [
          {
            betId: open.id,
            playerId: bob.id,
            status: 'accepted',
            result: null,
            currency: 'USD',
            stake: amount(20),
            potentialPayout: amount(100),
            payoutTotal: amount(0),
            legs: 2,
            placedAt: '2026-01-31T23:59:59.999Z',
            settledAt: null,
          },
          {
            betId: settled.id,
            playerId: alice.id,
            status: 'settled',
            result: 'won',
            currency: 'USD',
            stake: amount(10),
            potentialPayout: amount(25),
            payoutTotal: amount(25),
            legs: 1,
            placedAt: '2026-01-10T10:00:00.000Z',
            settledAt: '2026-01-12T10:00:00.000Z',
          },
          expect.objectContaining({ betId: orphan.id, playerId: null }),
        ],
      },
    });
    const served = JSON.stringify(result);
    for (const hidden of ['Secret Derby', 'Match winner', 'Home', bob.userId, alice.userId]) {
      expect(served).not.toContain(hidden);
    }
  });

  it('filters by player, status, result, currency and stake, sorts by payout, and counts past the limit', async () => {
    const kernel = bootKernel();
    const [alice, bob] = [await seedPlayer(), await seedPlayer()];
    const placed = (day: string) => AT(`2026-01-${day}T10:00:00.000Z`);
    const [, large, middle] = await Promise.all(
      [
        { potentialPayout: '30', stake: '15' },
        { potentialPayout: '300', stake: '50' },
        { potentialPayout: '120', stake: '15' },
      ].map((values, index) =>
        seedBet(alice.userId, {
          status: 'settled',
          result: 'lost',
          createdAt: placed(String(10 + index)),
          ...values,
        }),
      ),
    );
    await seedBet(alice.userId, {
      status: 'settled',
      result: 'lost',
      stake: '14.99',
      potentialPayout: '500',
      createdAt: placed('14'),
    });
    await seedBet(alice.userId, {
      status: 'settled',
      result: 'won',
      stake: '15',
      potentialPayout: '500',
      createdAt: placed('15'),
    });
    await seedBet(alice.userId, {
      status: 'accepted',
      stake: '15',
      potentialPayout: '500',
      createdAt: placed('16'),
    });
    await seedBet(alice.userId, {
      currency: 'EUR',
      status: 'settled',
      result: 'lost',
      stake: '15',
      potentialPayout: '500',
      createdAt: placed('17'),
    });
    await seedBet(bob.userId, {
      status: 'settled',
      result: 'lost',
      stake: '15',
      potentialPayout: '500',
      createdAt: placed('18'),
    });

    const result = await kernel.invokeTool(
      'sportsbook.bets_find',
      {
        ...RANGE,
        playerId: alice.id,
        status: ['settled'],
        result: ['lost', 'half_lost'],
        currency: 'usd',
        minStake: '15',
        sortBy: 'potentialPayout',
        sortDir: 'desc',
        limit: 2,
      },
      runContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        total: 3,
        truncated: true,
        bets: [{ betId: large.id }, { betId: middle.id }],
      },
    });
  });

  it('refuses a range over 92 days and a limit over 50', async () => {
    const kernel = bootKernel();

    for (const input of [
      { placedFrom: '2026-01-01', placedTo: '2026-04-03' },
      { placedFrom: '2026-02-01', placedTo: '2026-01-31' },
      { limit: 51 },
      { playerId: 'not-a-player' },
    ]) {
      expect(await kernel.invokeTool('sportsbook.bets_find', input, runContext())).toMatchObject({
        ok: false,
        error: 'invalid_input',
      });
    }
  });
});

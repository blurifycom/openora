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
import type { RunContext, TagKey } from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { playerTag, tag } from '@openora/core/pam/schema/tag';
import { migrate as migrateTag } from '@openora/core/pam/migrate/tag';
import { makeAuditWriter } from '../../../testing/mock.js';
import playerManagementPlugin from '../plugin.js';

let db: TestDb;

const AT = (iso: string) => new Date(iso);
const amount = (value: number) => expect.stringMatching(new RegExp(`^${value}(\\.0+)?$`));

// Only players.find: player.summary's factory needs identity and wallet ports this test does not bind.
function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('player-management');
  playerManagementPlugin.register(registry);
  return createMcpKernel({
    tools: registry.mcp.getTools().filter((tool) => tool.contract.id === 'players.find'),
    actions: [],
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
}

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: randomUUID() },
  catalogVersion: 'test',
  correlationId: 'players-find-tool',
});

async function seedPlayer(values: Partial<typeof player.$inferInsert> = {}) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(player)
      .values({
        userId: randomUUID(),
        firstName: 'Hidden',
        lastName: 'Person',
        phone: '+35699999999',
        registrationIp: '203.0.113.7',
        ...values,
      })
      .returning(),
    new Error('seedPlayer: no row'),
  );
}

async function tagPlayer(playerId: string, key: TagKey, removedAt: Date | null = null) {
  const [existing] = await db.drizzle.db
    .select({ id: tag.id })
    .from(tag)
    .where(sql`${tag.key} = ${key}`);
  const tagId =
    existing?.id ??
    findOneOrThrow(
      await db.drizzle.db.insert(tag).values({ key }).returning({ id: tag.id }),
      new Error('tagPlayer: no tag'),
    ).id;
  await db.drizzle.db.insert(playerTag).values({
    playerId,
    tagId,
    assignReason: 'test',
    assignActor: 'manual',
    removedAt,
  });
}

beforeAll(async () => {
  db = await createTestDb([migrateProfile, migrateTag]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tag}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('players.find through the MCP kernel (real PG)', () => {
  it('lists the players holding every tag asked for, by player id and without personal data', async () => {
    const kernel = bootKernel();
    const vipHighRoller = await seedPlayer({
      country: 'MT',
      currency: 'EUR',
      kycStatus: 'verified',
      level: 7,
      totalDeposits: '1500.00',
      totalWagered: '9000.50',
      lastSeenAt: AT('2026-03-02T10:00:00.000Z'),
      createdAt: AT('2026-01-05T08:00:00.000Z'),
    });
    const vipOnly = await seedPlayer({ createdAt: AT('2026-01-06T08:00:00.000Z') });
    const formerVip = await seedPlayer({ createdAt: AT('2026-01-07T08:00:00.000Z') });
    await tagPlayer(vipHighRoller.id, 'vip');
    await tagPlayer(vipHighRoller.id, 'high_roller');
    await tagPlayer(vipOnly.id, 'vip');
    await tagPlayer(formerVip.id, 'vip', AT('2026-02-01T00:00:00.000Z'));
    await tagPlayer(formerVip.id, 'high_roller');

    const result = await kernel.invokeTool(
      'players.find',
      { tagKeys: ['vip', 'high_roller'] },
      runContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        total: 1,
        truncated: false,
        players: [
          {
            playerId: vipHighRoller.id,
            status: 'active',
            kycStatus: 'approved',
            country: 'MT',
            currency: 'EUR',
            level: 7,
            registeredAt: '2026-01-05T08:00:00.000Z',
            lastSeenAt: '2026-03-02T10:00:00.000Z',
            totalDeposits: amount(1500),
            totalWagered: '9000.50',
            tagKeys: ['high_roller', 'vip'],
          },
        ],
      },
    });
    const served = JSON.stringify(result);
    for (const personal of [
      vipHighRoller.userId,
      'Hidden',
      'Person',
      '+35699999999',
      '203.0.113.7',
    ]) {
      expect(served).not.toContain(personal);
    }
  });

  it('filters by status, KYC status, country, currency, days and deposits, and counts past the limit', async () => {
    const kernel = bootKernel();
    const matching = await Promise.all(
      ['2026-02-01', '2026-02-02', '2026-02-03'].map((day) =>
        seedPlayer({
          country: 'de',
          currency: 'EUR',
          kycStatus: 'pending',
          totalDeposits: '200.00',
          createdAt: AT(`${day}T12:00:00.000Z`),
        }),
      ),
    );
    await seedPlayer({
      country: 'DE',
      currency: 'EUR',
      kycStatus: 'pending',
      totalDeposits: '199.99',
      createdAt: AT('2026-02-02T12:00:00.000Z'),
    });
    await seedPlayer({
      country: 'DE',
      currency: 'USD',
      kycStatus: 'pending',
      totalDeposits: '500.00',
      createdAt: AT('2026-02-02T12:00:00.000Z'),
    });
    await seedPlayer({
      country: 'DE',
      currency: 'EUR',
      kycStatus: 'approved',
      totalDeposits: '500.00',
      createdAt: AT('2026-02-02T12:00:00.000Z'),
    });
    await seedPlayer({
      country: 'DE',
      currency: 'EUR',
      kycStatus: 'pending',
      status: 'closed',
      totalDeposits: '500.00',
      createdAt: AT('2026-02-02T12:00:00.000Z'),
    });
    // The first instant past registeredTo does not count.
    await seedPlayer({
      country: 'DE',
      currency: 'EUR',
      kycStatus: 'pending',
      totalDeposits: '500.00',
      createdAt: AT('2026-02-04T00:00:00.000Z'),
    });

    const result = await kernel.invokeTool(
      'players.find',
      {
        status: ['active', 'dormant'],
        kycStatus: ['pending', 'resubmission_requested'],
        country: 'DE',
        currency: 'eur',
        registeredFrom: '2026-02-01',
        registeredTo: '2026-02-03',
        minTotalDeposits: '200',
        sortBy: 'registeredAt',
        sortDir: 'asc',
        limit: 2,
      },
      runContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        total: 3,
        truncated: true,
        players: [{ playerId: matching[0]?.id }, { playerId: matching[1]?.id }],
      },
    });
  });

  it('matches a legacy verified row for approved, and sorts a player never seen last', async () => {
    const kernel = bootKernel();
    const legacy = await seedPlayer({
      kycStatus: 'verified',
      lastSeenAt: AT('2026-01-01T00:00:00.000Z'),
    });
    const recent = await seedPlayer({
      kycStatus: 'approved',
      lastSeenAt: AT('2026-03-01T00:00:00.000Z'),
    });
    const neverSeen = await seedPlayer({ kycStatus: 'approved', lastSeenAt: null });
    await seedPlayer({ kycStatus: 'rejected', lastSeenAt: AT('2026-03-05T00:00:00.000Z') });

    for (const sortDir of ['desc', 'asc'] as const) {
      const result = await kernel.invokeTool(
        'players.find',
        { kycStatus: ['approved'], sortBy: 'lastSeenAt', sortDir },
        runContext(),
      );
      const order = sortDir === 'desc' ? [recent, legacy] : [legacy, recent];
      expect(result).toMatchObject({
        ok: true,
        output: {
          total: 3,
          players: [...order, neverSeen].map((row) => ({
            playerId: row.id,
            kycStatus: 'approved',
          })),
        },
      });
    }

    const seen = await kernel.invokeTool(
      'players.find',
      { lastSeenFrom: '2026-02-01', lastSeenTo: '2026-03-01' },
      runContext(),
    );
    expect(seen).toMatchObject({
      ok: true,
      output: { total: 1, players: [{ playerId: recent.id }] },
    });
  });

  it('refuses a filter it cannot serve', async () => {
    const kernel = bootKernel();

    for (const input of [
      { limit: 51 },
      { tagKeys: Array.from({ length: 11 }, () => 'vip') },
      { tagKeys: ['whale'] },
      { country: 'DEU' },
      { minTotalDeposits: '-1' },
      { registeredFrom: '2026-02-02', registeredTo: '2026-02-01' },
      { sortBy: 'email' },
    ]) {
      expect(await kernel.invokeTool('players.find', input, runContext())).toMatchObject({
        ok: false,
        error: 'invalid_input',
      });
    }
  });
});

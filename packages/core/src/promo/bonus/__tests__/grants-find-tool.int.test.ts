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
import { promoGrant } from '../schema/index.js';
import bonusPlugin from '../plugin.js';

let db: TestDb;

const DAY_MS = 24 * 60 * 60 * 1000;
const AT = (iso: string) => new Date(iso);
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);
const amount = (value: number) => expect.stringMatching(new RegExp(`^${value}(\\.0+)?$`));
const FORFEIT_NOTE = 'player admitted to multi-accounting on a call';

function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('bonus');
  bonusPlugin.register(registry);
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
  correlationId: 'grants-find-tool',
});

async function seedPlayer() {
  return findOneOrThrow(
    await db.drizzle.db.insert(player).values({ userId: randomUUID() }).returning(),
    new Error('seedPlayer: no row'),
  );
}

async function seedGrant(
  userId: string,
  values: Partial<typeof promoGrant.$inferInsert> & {
    status: (typeof promoGrant.$inferInsert)['status'];
  },
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(promoGrant)
      .values({
        userId,
        currency: 'USD',
        source: 'deposit',
        sourceRef: randomUUID(),
        terms: { wageringMultiplier: '3', expiryDays: 14, weights: [] },
        grantedAmount: '100',
        wageringRequired: '300',
        expiresAt: inDays(14),
        ...values,
      })
      .returning(),
    new Error('seedGrant: no row'),
  );
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${promoGrant}, ${player} RESTART IDENTITY CASCADE`);
});

describe('bonus.grants_find through the MCP kernel (real PG)', () => {
  it('lists the grants by player id, newest first, without the forfeit note', async () => {
    const kernel = bootKernel();
    const [alice, bob] = [await seedPlayer(), await seedPlayer()];
    const active = await seedGrant(alice.userId, {
      status: 'active',
      bonusBalance: '80',
      wageringProgress: '120.5',
      activatedAt: AT('2026-01-05T10:00:00.000Z'),
      expiresAt: AT('2030-01-19T10:00:00.000Z'),
      createdAt: AT('2026-01-05T10:00:00.000Z'),
    });
    const forfeited = await seedGrant(bob.userId, {
      status: 'forfeited',
      source: 'manual',
      forfeitReason: 'admin',
      forfeitedBy: randomUUID(),
      forfeitNote: FORFEIT_NOTE,
      activatedAt: AT('2026-01-03T10:00:00.000Z'),
      closedAt: AT('2026-01-04T10:00:00.000Z'),
      createdAt: AT('2026-01-03T10:00:00.000Z'),
    });
    // A grant whose player has no profile row is still listed, by no player.
    const orphan = await seedGrant(randomUUID(), {
      status: 'pending',
      createdAt: AT('2026-01-01T10:00:00.000Z'),
    });

    const result = await kernel.invokeTool('bonus.grants_find', {}, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        total: 3,
        truncated: false,
        grants: [
          {
            grantId: active.id,
            playerId: alice.id,
            status: 'active',
            source: 'deposit',
            currency: 'USD',
            grantedAmount: amount(100),
            bonusBalance: amount(80),
            wageringRequired: amount(300),
            wageringProgress: '120.500000000000000000',
            activatedAt: '2026-01-05T10:00:00.000Z',
            expiresAt: '2030-01-19T10:00:00.000Z',
            closedAt: null,
            forfeitReason: null,
          },
          expect.objectContaining({
            grantId: forfeited.id,
            playerId: bob.id,
            status: 'forfeited',
            forfeitReason: 'admin',
            closedAt: '2026-01-04T10:00:00.000Z',
          }),
          expect.objectContaining({ grantId: orphan.id, playerId: null, activatedAt: null }),
        ],
      },
    });
    const served = JSON.stringify(result);
    for (const hidden of [FORFEIT_NOTE, alice.userId, bob.userId]) {
      expect(served).not.toContain(hidden);
    }
  });

  it('filters by player, status, source, currency and activation days, and counts past the limit', async () => {
    const kernel = bootKernel();
    const [alice, bob] = [await seedPlayer(), await seedPlayer()];
    const activated = (day: string) => AT(`2026-01-${day}T10:00:00.000Z`);
    const [, middle, newest] = await Promise.all(
      ['10', '11', '12'].map((day) =>
        seedGrant(alice.userId, {
          status: 'active',
          activatedAt: activated(day),
          createdAt: activated(day),
        }),
      ),
    );
    await seedGrant(alice.userId, {
      status: 'active',
      source: 'manual',
      activatedAt: activated('13'),
    });
    await seedGrant(alice.userId, {
      status: 'expired',
      activatedAt: activated('13'),
      closedAt: activated('20'),
    });
    await seedGrant(alice.userId, {
      status: 'active',
      currency: 'EUR',
      activatedAt: activated('13'),
    });
    // The first instant past activatedTo does not count.
    await seedGrant(alice.userId, {
      status: 'active',
      activatedAt: AT('2026-01-16T00:00:00.000Z'),
    });
    await seedGrant(bob.userId, { status: 'active', activatedAt: activated('13') });

    const result = await kernel.invokeTool(
      'bonus.grants_find',
      {
        playerId: alice.id,
        status: ['active', 'pending'],
        source: ['deposit'],
        currency: 'usd',
        activatedFrom: '2026-01-10',
        activatedTo: '2026-01-15',
        limit: 2,
      },
      runContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        total: 3,
        truncated: true,
        grants: [{ grantId: newest.id }, { grantId: middle.id }],
      },
    });
  });

  it('lists the live grants expiring soonest first within the days asked', async () => {
    const kernel = bootKernel();
    const row = await seedPlayer();
    const soonest = await seedGrant(row.userId, { status: 'active', expiresAt: inDays(1) });
    const pending = await seedGrant(row.userId, { status: 'pending', expiresAt: inDays(5) });
    await seedGrant(row.userId, { status: 'active', expiresAt: inDays(8) });
    await seedGrant(row.userId, {
      status: 'completed',
      expiresAt: inDays(2),
      closedAt: new Date(),
    });
    await seedGrant(row.userId, { status: 'active', expiresAt: inDays(-1) });

    const result = await kernel.invokeTool(
      'bonus.grants_find',
      { expiringWithinDays: 7 },
      runContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        total: 2,
        truncated: false,
        grants: [
          { grantId: soonest.id, status: 'active' },
          { grantId: pending.id, status: 'pending' },
        ],
      },
    });
  });

  it('refuses a filter it cannot serve', async () => {
    const kernel = bootKernel();

    for (const input of [
      { limit: 51 },
      { expiringWithinDays: 91 },
      { status: ['live'] },
      { activatedFrom: '2026-01-02', activatedTo: '2026-01-01' },
    ]) {
      expect(await kernel.invokeTool('bonus.grants_find', input, runContext())).toMatchObject({
        ok: false,
        error: 'invalid_input',
      });
    }
  });
});

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
import type { BonusGrantEntryType, RunContext } from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { promoGrant, promoGrantEntry } from '../schema/index.js';
import bonusPlugin from '../plugin.js';

let db: TestDb;

const RANGE = { dateFrom: '2026-01-01', dateTo: '2026-01-31' };
const DAY_MS = 24 * 60 * 60 * 1000;
const AT = (iso: string) => new Date(iso);
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);
const amount = (value: number) => expect.stringMatching(new RegExp(`^${value}(\\.0+)?$`));

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
  correlationId: 'grants-summary-tool',
});

async function seedGrant(
  values: Partial<typeof promoGrant.$inferInsert> & {
    status: (typeof promoGrant.$inferInsert)['status'];
    grantedAmount: string;
  },
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(promoGrant)
      .values({
        userId: randomUUID(),
        currency: 'USD',
        source: 'deposit',
        sourceRef: randomUUID(),
        terms: { wageringMultiplier: '3', expiryDays: 14, weights: [] },
        wageringRequired: '0',
        expiresAt: inDays(14),
        ...values,
      })
      .returning(),
    new Error('seedGrant: no row'),
  );
}

// One transaction: the ledger check at commit wants the entries to sum to the grant's balance.
async function seedEntries(
  grant: typeof promoGrant.$inferSelect,
  entries: [BonusGrantEntryType, string][],
) {
  await db.drizzle.db.insert(promoGrantEntry).values(
    entries.map(([type, bonusAmount]) => ({
      grantId: grant.id,
      userId: grant.userId,
      currency: grant.currency,
      type,
      bonusAmount,
      balanceAfter: '0',
    })),
  );
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${promoGrantEntry}, ${promoGrant} RESTART IDENTITY CASCADE`,
  );
});

describe('bonus.grants_summary through the MCP kernel (real PG)', () => {
  it('counts what was granted and how grants ended in range, and what the live ones hold now', async () => {
    const kernel = bootKernel();
    const expiring = await seedGrant({
      status: 'active',
      grantedAmount: '100',
      bonusBalance: '80',
      wageringRequired: '300',
      wageringProgress: '100',
      activatedAt: AT('2026-01-05T10:00:00.000Z'),
      expiresAt: inDays(2),
    });
    // Granted before the range: live now, not granted in it.
    await seedGrant({
      status: 'active',
      source: 'manual',
      grantedAmount: '50',
      bonusBalance: '50',
      wageringRequired: '150',
      activatedAt: AT('2025-12-20T10:00:00.000Z'),
      expiresAt: inDays(30),
    });
    const converted = await seedGrant({
      status: 'completed',
      grantedAmount: '40',
      wageringRequired: '120',
      wageringProgress: '120',
      activatedAt: AT('2026-01-02T10:00:00.000Z'),
      closedAt: AT('2026-01-20T10:00:00.000Z'),
    });
    await seedEntries(converted, [
      ['grant', '40'],
      ['win', '20'],
      ['convert', '-60'],
    ]);
    const expired = await seedGrant({
      status: 'expired',
      source: 'cashback',
      grantedAmount: '10',
      activatedAt: AT('2026-01-03T10:00:00.000Z'),
      closedAt: AT('2026-01-17T10:00:00.000Z'),
    });
    await seedEntries(expired, [
      ['grant', '10'],
      ['stake', '-3'],
      ['expire', '-7'],
    ]);
    const forfeited = await seedGrant({
      status: 'forfeited',
      forfeitReason: 'self_exclusion',
      forfeitNote: 'free text that must stay out',
      grantedAmount: '20',
      activatedAt: AT('2026-01-04T10:00:00.000Z'),
      closedAt: AT('2026-01-06T10:00:00.000Z'),
    });
    await seedEntries(forfeited, [
      ['grant', '20'],
      ['forfeit', '-20'],
    ]);
    await seedGrant({
      status: 'cancelled',
      grantedAmount: '15',
      closedAt: AT('2026-01-07T10:00:00.000Z'),
    });
    await seedGrant({ status: 'pending', grantedAmount: '15' });
    // Funded in the range and taken away after it: granted in it, not forfeited in it.
    await seedGrant({
      status: 'forfeited',
      forfeitReason: 'admin',
      grantedAmount: '30',
      activatedAt: AT('2026-01-04T10:00:00.000Z'),
      closedAt: AT('2026-02-02T10:00:00.000Z'),
    });
    await seedGrant({
      status: 'active',
      currency: 'EUR',
      source: 'rain',
      grantedAmount: '5',
      bonusBalance: '5',
      activatedAt: AT('2026-01-09T10:00:00.000Z'),
    });

    const result = await kernel.invokeTool('bonus.grants_summary', RANGE, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        ...RANGE,
        currencies: [
          expect.objectContaining({
            currency: 'EUR',
            granted: { count: 1, amount: amount(5) },
            bySource: [expect.objectContaining({ source: 'rain' })],
          }),
          {
            currency: 'USD',
            granted: { count: 5, amount: amount(200) },
            converted: { count: 1, amount: amount(60) },
            expired: { count: 1, amount: amount(7) },
            forfeited: {
              count: 1,
              amount: amount(20),
              byReason: [{ reason: 'self_exclusion', count: 1 }],
            },
            cancelled: 1,
            bySource: [
              {
                source: 'cashback',
                granted: { count: 1, amount: amount(10) },
                converted: { count: 0, amount: amount(0) },
              },
              {
                source: 'deposit',
                granted: { count: 4, amount: amount(190) },
                converted: { count: 1, amount: amount(60) },
              },
            ],
            outstanding: {
              activeGrants: 2,
              pendingGrants: 1,
              bonusBalance: amount(130),
              wageringRemaining: amount(350),
              expiringSoon: { count: 1, amount: amount(80) },
            },
          },
        ],
        truncated: false,
      },
    });
    const served = JSON.stringify(result);
    expect(served).not.toContain('free text');
    expect(served).not.toContain(expiring.userId);
  });

  it('narrows to one source and currency, and refuses a range over 366 days', async () => {
    const kernel = bootKernel();
    await seedGrant({
      status: 'active',
      source: 'cashback',
      grantedAmount: '10',
      bonusBalance: '10',
      activatedAt: AT('2026-01-03T10:00:00.000Z'),
    });
    await seedGrant({
      status: 'active',
      grantedAmount: '100',
      bonusBalance: '100',
      activatedAt: AT('2026-01-03T10:00:00.000Z'),
    });

    expect(
      await kernel.invokeTool(
        'bonus.grants_summary',
        { ...RANGE, source: 'cashback', currency: 'usd' },
        runContext(),
      ),
    ).toMatchObject({
      ok: true,
      output: {
        currencies: [
          {
            currency: 'USD',
            granted: { count: 1, amount: amount(10) },
            outstanding: { activeGrants: 1, bonusBalance: amount(10) },
          },
        ],
      },
    });
    expect(
      await kernel.invokeTool(
        'bonus.grants_summary',
        { dateFrom: '2025-01-01', dateTo: '2026-01-02' },
        runContext(),
      ),
    ).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});

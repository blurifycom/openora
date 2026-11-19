import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  Container,
  DRIZZLE,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import type { RunContext } from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter } from '../../../testing/mock.js';
import { RakebackLiabilityInputSchema } from '../contract/index.js';
import { migrate } from '../migrate.js';
import { promoRakebackAccrual, promoRakebackClaim } from '../schema/index.js';
import gamificationPlugin from '../plugin.js';

let db: TestDb;

const RANGE = { dateFrom: '2026-01-01', dateTo: '2026-01-31' };
const AT = (iso: string) => new Date(iso);
const amount = (value: number) => expect.stringMatching(new RegExp(`^${value}(\\.0+)?$`));

function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('gamification');
  gamificationPlugin.register(registry);
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
  correlationId: 'rakeback-liability-tool',
});

async function seedAccrual(
  userId: string,
  values: Partial<typeof promoRakebackAccrual.$inferInsert> & { amount: string },
) {
  await db.drizzle.db.insert(promoRakebackAccrual).values({
    userId,
    currency: 'USD',
    stake: '100',
    basis: 'stake',
    ratePercent: '1',
    boostPercent: '0',
    createdAt: AT('2026-01-10T10:00:00.000Z'),
    ...values,
  });
}

async function seedClaim(userId: string, settledAt: Date) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(promoRakebackClaim)
      .values({ userId, idempotencyKey: randomUUID(), outcome: 'claimed', settledAt })
      .returning(),
    new Error('seedClaim: no row'),
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
    sql`TRUNCATE ${promoRakebackAccrual}, ${promoRakebackClaim} RESTART IDENTITY CASCADE`,
  );
});

describe('bonus.rakeback_liability input', () => {
  it('spans at most 366 days', () => {
    const parse = (input: unknown) => z.safeParse(RakebackLiabilityInputSchema, input).success;
    expect(parse({ dateFrom: '2026-01-01', dateTo: '2027-01-01' })).toBe(true);
    expect(parse({ dateFrom: '2026-01-01', dateTo: '2027-01-02' })).toBe(false);
  });
});

describe('bonus.rakeback_liability through the MCP kernel (real PG)', () => {
  it('owes the unclaimed rakeback now, and counts what accrued and was claimed in the range', async () => {
    const kernel = bootKernel();
    const [alice, bob] = [randomUUID(), randomUUID()];
    // Unclaimed now: two of Alice's, one of Bob's, one accrued before the range.
    await seedAccrual(alice, { amount: '2' });
    await seedAccrual(alice, { amount: '3' });
    await seedAccrual(bob, { amount: '5', createdAt: AT('2025-12-20T10:00:00.000Z') });
    // Accrued in the range, claimed on its last millisecond.
    const lastDay = await seedClaim(bob, AT('2026-01-31T23:59:59.999Z'));
    await seedAccrual(bob, {
      amount: '7',
      status: 'claimed',
      claimId: lastDay.id,
      settledAt: lastDay.settledAt,
    });
    // Claimed the first moment after the range: a later period's.
    const later = await seedClaim(alice, AT('2026-02-01T00:00:00.000Z'));
    await seedAccrual(alice, {
      amount: '11',
      status: 'claimed',
      claimId: later.id,
      settledAt: later.settledAt,
    });
    await seedAccrual(alice, { amount: '13', status: 'voided', voidReason: 'reversed round' });
    await seedAccrual(alice, { amount: '4', currency: 'EUR' });

    const result = await kernel.invokeTool('bonus.rakeback_liability', RANGE, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        ...RANGE,
        currencies: [
          {
            currency: 'EUR',
            unclaimed: { amount: amount(4), accruals: 1, players: 1 },
            accrued: { amount: amount(4), accruals: 1, players: 1 },
            claimed: { amount: amount(0), accruals: 0, players: 0 },
          },
          {
            currency: 'USD',
            unclaimed: { amount: amount(10), accruals: 3, players: 2 },
            accrued: { amount: amount(36), accruals: 5, players: 2 },
            claimed: { amount: amount(7), accruals: 1, players: 1 },
          },
        ],
        truncated: false,
      },
    });
    expect(
      await kernel.invokeTool(
        'bonus.rakeback_liability',
        { ...RANGE, currency: 'eur' },
        runContext(),
      ),
    ).toMatchObject({ ok: true, output: { currencies: [{ currency: 'EUR' }] } });
  });

  it('refuses a range over 366 days', async () => {
    expect(
      await bootKernel().invokeTool(
        'bonus.rakeback_liability',
        { dateFrom: '2026-01-01', dateTo: '2027-01-02' },
        runContext(),
      ),
    ).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});

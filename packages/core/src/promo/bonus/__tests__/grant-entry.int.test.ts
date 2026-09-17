import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow, type DrizzleTx } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { AuditWritePort, BonusGrantArgs, Uuid } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { promoGrant, promoGrantEntry, promoWeightProfile } from '../schema/index.js';
import { GrantService } from '../service/grant.service.js';

let db: TestDb;
let service: GrantService;
let weightProfileId: Uuid;

const args = (over: Partial<BonusGrantArgs> = {}): BonusGrantArgs => ({
  userId: randomUUID(),
  currency: 'USD',
  amount: '100',
  source: 'deposit',
  sourceRef: randomUUID(),
  terms: { wageringMultiplier: '35', expiryDays: 30, weightProfileId },
  ...over,
});

const grant = (a: BonusGrantArgs) =>
  db.drizzle.db.transaction((tx) => service.grant(tx as unknown as DrizzleTx, a));

const entries = () => db.drizzle.db.select().from(promoGrantEntry);

const ledgerSum = async (grantId: string): Promise<string> => {
  const [row] = await db.drizzle.db
    .select({ total: sql<string>`coalesce(sum(${promoGrantEntry.bonusAmount}), 0)::text` })
    .from(promoGrantEntry)
    .where(eq(promoGrantEntry.grantId, grantId));
  return row?.total ?? '0';
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
  const audit: AuditWritePort = { record: vi.fn(), recordInTransaction: vi.fn() };
  service = new GrantService(audit);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${promoGrant} RESTART IDENTITY CASCADE`);
  weightProfileId = findOneOrThrow(
    await db.drizzle.db
      .insert(promoWeightProfile)
      .values({ name: `profile-${randomUUID()}` })
      .returning(),
    new Error('seed profile: query returned no row'),
  ).id as Uuid;
});

describe('promo grant ledger (real PG)', () => {
  it('opens the ledger with one entry carrying the granted amount', async () => {
    const outcome = await grant(args({ amount: '250' }));
    if (!outcome.ok) {throw new Error('grant was refused');}

    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      grantId: outcome.grantId,
      type: 'grant',
      bonusAmount: '250.000000000000000000',
      realAmount: '0.000000000000000000',
      wageringDelta: '0.000000000000000000',
      balanceAfter: '250.000000000000000000',
      externalRoundId: null,
      walletTransactionId: null,
    });
  });

  it('IDM-01: a replayed grant adds no second ledger entry', async () => {
    const a = args();
    const first = await grant(a);
    const second = await grant(a);

    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(await entries()).toHaveLength(1);
  });

  it('IDM-03: concurrent replays settle on one grant and one ledger entry', async () => {
    const a = args();
    const outcomes = await Promise.all([grant(a), grant(a), grant(a)]);

    expect(outcomes.filter((o) => o.ok && o.created)).toHaveLength(1);
    expect(await entries()).toHaveLength(1);
  });

  it('LDG-01: the sum of a grant ledger equals the bonus balance it explains', async () => {
    const outcome = await grant(args({ amount: '77.5' }));
    if (!outcome.ok) {throw new Error('grant was refused');}

    const [row] = await db.drizzle.db
      .select()
      .from(promoGrant)
      .where(eq(promoGrant.id, outcome.grantId));
    expect(await ledgerSum(outcome.grantId)).toBe(row?.bonusBalance);
  });

  it('keeps one ledger per grant when a player holds several', async () => {
    const userId = randomUUID();
    const one = await grant(args({ userId, amount: '10' }));
    const two = await grant(args({ userId, amount: '20' }));
    if (!one.ok || !two.ok) {throw new Error('grant was refused');}

    expect(await ledgerSum(one.grantId)).toBe('10.000000000000000000');
    expect(await ledgerSum(two.grantId)).toBe('20.000000000000000000');
  });

  it('takes the ledger with the grant when the grant is deleted', async () => {
    const outcome = await grant(args());
    if (!outcome.ok) {throw new Error('grant was refused');}

    await db.drizzle.db.delete(promoGrant).where(eq(promoGrant.id, outcome.grantId));
    expect(await entries()).toHaveLength(0);
  });

  it('rolls the ledger back with the grant when the caller fails', async () => {
    const a = args();
    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await service.grant(tx as unknown as DrizzleTx, a);
        throw new Error('caller failed after the grant');
      }),
    ).rejects.toThrow('caller failed after the grant');

    expect(await entries()).toHaveLength(0);
  });
});

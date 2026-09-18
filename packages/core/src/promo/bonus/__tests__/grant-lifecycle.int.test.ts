import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { BonusGrantArgs, Uuid } from '@openora/core/contracts';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { promoGrant, promoGrantEntry, promoWeight, promoWeightProfile } from '../schema/index.js';
import { GrantLifecycleService } from '../service/grant-lifecycle.service.js';
import { GrantService } from '../service/grant.service.js';

let db: TestDb;
let grants: GrantService;
let lifecycle: GrantLifecycleService;
let audit: ReturnType<typeof makeAuditWriter>;
let weightProfileId: Uuid;

const args = (over: Partial<BonusGrantArgs> = {}): BonusGrantArgs => ({
  userId: randomUUID(),
  currency: 'USD',
  amount: '100',
  source: 'deposit',
  sourceRef: randomUUID(),
  actor: { type: 'system' },
  terms: { wageringMultiplier: '5', expiryDays: 30, weightProfileId },
  ...over,
});

const grant = async (over: Partial<BonusGrantArgs> = {}) => {
  const outcome = await db.drizzle.db.transaction((tx) => grants.grant(tx, args(over)));
  if (!outcome.ok) {
    throw new Error('grant was refused');
  }
  return outcome.grantId;
};

const rowOf = async (id: string) =>
  findOneOrThrow(
    await db.drizzle.db.select().from(promoGrant).where(eq(promoGrant.id, id)),
    new Error('rowOf: query returned no row'),
  );

const entriesOf = (id: string) =>
  db.drizzle.db.select().from(promoGrantEntry).where(eq(promoGrantEntry.grantId, id));

const expireNow = (id: string) =>
  db.drizzle.db
    .update(promoGrant)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(promoGrant.id, id));

beforeAll(async () => {
  db = await createTestDb([migrate]);
  audit = makeAuditWriter();
  grants = new GrantService(audit);
  lifecycle = new GrantLifecycleService(db.drizzle, audit);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(promoGrantEntry);
  await db.drizzle.db.delete(promoGrant);
  await db.drizzle.db.delete(promoWeight);
  await db.drizzle.db.delete(promoWeightProfile);
  vi.clearAllMocks();
  weightProfileId = findOneOrThrow(
    await db.drizzle.db
      .insert(promoWeightProfile)
      .values({ name: `profile-${randomUUID()}` })
      .returning(),
    new Error('seed profile: query returned no row'),
  ).id;
});

describe('the expiry sweep', () => {
  it('closes a grant whose expiry has passed and takes what was left of it', async () => {
    const grantId = await grant({ amount: '80' });
    await expireNow(grantId);

    const closed = await lifecycle.expireDue();

    expect(closed).toMatchObject([{ grantId, forfeitedAmount: '80.000000000000000000' }]);
    const row = await rowOf(grantId);
    expect(row).toMatchObject({ status: 'expired', bonusBalance: '0.000000000000000000' });
    expect(row.closedAt).toBeInstanceOf(Date);
  });

  it('writes one ledger entry for the funds that died with the grant', async () => {
    const grantId = await grant({ amount: '80' });
    await expireNow(grantId);

    await lifecycle.expireDue();

    const entries = await entriesOf(grantId);
    expect(entries.filter((e) => e.type === 'expire')).toMatchObject([
      { bonusAmount: '-80.000000000000000000', balanceAfter: '0.000000000000000000' },
    ]);
  });

  it('leaves a grant that is not yet due alone', async () => {
    const grantId = await grant();

    expect(await lifecycle.expireDue()).toEqual([]);
    expect((await rowOf(grantId)).status).toBe('active');
  });

  it('takes nothing a second time when the sweep runs again', async () => {
    const grantId = await grant();
    await expireNow(grantId);

    await lifecycle.expireDue();
    const second = await lifecycle.expireDue();

    expect(second).toEqual([]);
    expect(await entriesOf(grantId)).toHaveLength(2);
  });

  it('does not sweep a grant that already reached a terminal status', async () => {
    const grantId = await grant();
    await db.drizzle.db
      .update(promoGrant)
      .set({ status: 'completed', bonusBalance: '0' })
      .where(eq(promoGrant.id, grantId));
    await expireNow(grantId);

    expect(await lifecycle.expireDue()).toEqual([]);
    expect((await rowOf(grantId)).status).toBe('completed');
  });

  it('writes one audit row per grant it closed', async () => {
    const first = await grant();
    const second = await grant();
    await expireNow(first);
    await expireNow(second);

    await lifecycle.expireDue();

    expect(audit.recordInTransaction).toHaveBeenCalledTimes(4);
    const actions = audit.recordInTransaction.mock.calls.map(([, entry]) => entry.action);
    expect(actions.filter((a) => a === 'promo.bonus.expired')).toHaveLength(2);
  });
});

describe('forfeiting every grant a player holds', () => {
  it('takes all of them, not just the newest', async () => {
    const userId = randomUUID();
    const first = await grant({ userId, amount: '10' });
    const second = await grant({ userId, amount: '20' });

    const closed = await lifecycle.forfeitAllFor(userId, 'self_exclusion');

    expect(closed.map((c) => c.grantId).sort()).toEqual([first, second].sort());
    expect((await rowOf(first)).status).toBe('forfeited');
    expect((await rowOf(second)).status).toBe('forfeited');
  });

  it('records the reason on the grant it took', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId });

    await lifecycle.forfeitAllFor(userId, 'account_closed');

    expect(await rowOf(grantId)).toMatchObject({
      status: 'forfeited',
      forfeitReason: 'account_closed',
    });
  });

  it('leaves another player’s grants untouched', async () => {
    const mine = await grant({ userId: randomUUID() });
    const theirs = await grant({ userId: randomUUID() });

    await lifecycle.forfeitAllFor((await rowOf(mine)).userId, 'self_exclusion');

    expect((await rowOf(theirs)).status).toBe('active');
  });

  it('records a player who excluded themselves as the player, not as an admin', async () => {
    const userId = randomUUID();
    await grant({ userId });

    await lifecycle.forfeitAllFor(userId, 'self_exclusion', { id: userId, isAdmin: false });

    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorType: 'player', actorId: userId }),
    );
  });

  it('names the admin when one took the grant away', async () => {
    const userId = randomUUID();
    const actorId = randomUUID();
    await grant({ userId });

    await lifecycle.forfeitAllFor(userId, 'admin', { id: actorId, isAdmin: true });

    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorType: 'admin', actorId, action: 'promo.bonus.forfeited' }),
    );
  });
});

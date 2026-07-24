import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { WalletReader, IdentityReader, TagKey, KycStatus } from '@openora/core/contracts';
import type { EventBus } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock, makeEvents } from '../../../testing/mock.js';
import { TagEvaluationService } from '../service/tag-evaluation.service.js';
import { SYSTEM_ACTOR_ID } from '../service/tag-mappers.js';
import { TagService } from '../service/tag.service.js';
import { TagRuleService } from '../service/tag-rule.service.js';
import { migrate } from '../migrate.js';
import { tag, tagRule, playerTag } from '../schema/index.js';

let db: TestDb;

type RuleOverrides = {
  isEnabled?: boolean;
  threshold?: string | null;
  thresholdDays?: number | null;
  thresholdCount?: number | null;
};

async function seedTagRow(key: TagKey) {
  const [row] = await db.drizzle.db.insert(tag).values({ key }).returning();
  return row!;
}

async function seedRule(key: TagKey, overrides: RuleOverrides = {}) {
  const tagRow = await seedTagRow(key);
  await db.drizzle.db.insert(tagRule).values({
    tagId: tagRow.id,
    isEnabled: true,
    threshold: null,
    thresholdDays: null,
    thresholdCount: null,
    ...overrides,
  });
  return tagRow;
}

async function seedKycPendingRule(overrides: RuleOverrides = {}) {
  const kycPendingTag = await seedRule('kyc_pending', overrides);
  const kycRejectedTag = await seedTagRow('kyc_rejected');
  return { kycPendingTag, kycRejectedTag };
}

async function seedActiveAssignment(playerId: string, tagRow: { id: string }) {
  const [row] = await db.drizzle.db
    .insert(playerTag)
    .values({
      playerId,
      tagId: tagRow.id,
      assignReason: 'seed fixture',
      assignActor: 'manual',
      assignActorUserId: null,
    })
    .returning();
  return row!;
}

async function activeTagKeys(playerId: string) {
  const rows = await db.drizzle.db
    .select({ key: tag.key })
    .from(playerTag)
    .innerJoin(tag, eq(playerTag.tagId, tag.id))
    .where(and(eq(playerTag.playerId, playerId), isNull(playerTag.removedAt)));
  return rows.map((r) => r.key);
}

async function assignmentRow(playerId: string, tagRow: { id: string }) {
  const [row] = await db.drizzle.db
    .select()
    .from(playerTag)
    .where(and(eq(playerTag.playerId, playerId), eq(playerTag.tagId, tagRow.id)));
  return row;
}

function makeServices(
  overrides: {
    walletReader?: Partial<WalletReader>;
    identityReader?: Partial<IdentityReader>;
  } = {},
) {
  const events = mock<EventBus>(makeEvents());
  const tagService = new TagService(db.drizzle, events);
  const ruleService = new TagRuleService(db.drizzle, events);
  const walletReader = mock<WalletReader>({
    getLifetimeDeposit: vi.fn().mockResolvedValue('0'),
    getWithdrawalCountInWindow: vi.fn().mockResolvedValue(0),
    ...overrides.walletReader,
  });
  const identityReader = mock<IdentityReader>({
    getLastLoginAt: vi.fn().mockResolvedValue(null),
    getPlayerIdsInactiveSince: vi.fn().mockResolvedValue([]),
    getPlayerIdByUserId: vi.fn(async (uid: string) => uid),
    ...overrides.identityReader,
  });
  const service = new TagEvaluationService(tagService, ruleService, walletReader, identityReader);
  return { service, walletReader, identityReader };
}

function depositPayload(userId: string, amount: number) {
  return { userId, amount: String(amount), currency: 'USD', transactionId: randomUUID() };
}
function withdrawalPayload(userId: string, amount: number) {
  return { userId, amount: String(amount), currency: 'USD', transactionId: randomUUID() };
}
function kycUpdatedPayload(userId: string, status: KycStatus) {
  return { userId, actorId: SYSTEM_ACTOR_ID, status, previousStatus: 'pending' };
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tagRule}, ${tag} RESTART IDENTITY CASCADE`,
  );
});

describe('TagEvaluationService.onDepositCompleted (real PG)', () => {
  it('assigns large_depositor when a single deposit meets the amount threshold', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('large_depositor', { threshold: '500' });

    await service.onDepositCompleted(depositPayload(userId, 500));

    expect(await activeTagKeys(userId)).toContain('large_depositor');
  });

  it('does not assign large_depositor when the deposit is below threshold', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('large_depositor', { threshold: '500' });

    await service.onDepositCompleted(depositPayload(userId, 499));

    expect(await activeTagKeys(userId)).not.toContain('large_depositor');
  });

  it('assigns high_roller when lifetime deposits meet the threshold', async () => {
    const userId = randomUUID();
    const { service } = makeServices({
      walletReader: { getLifetimeDeposit: vi.fn().mockResolvedValue('12000') },
    });
    await seedRule('high_roller', { threshold: '10000' });

    await service.onDepositCompleted(depositPayload(userId, 100));

    expect(await activeTagKeys(userId)).toContain('high_roller');
  });

  it('removes an active high_roller assignment when lifetime deposits fall below a raised threshold', async () => {
    const userId = randomUUID();
    const { service } = makeServices({
      walletReader: { getLifetimeDeposit: vi.fn().mockResolvedValue('5000') },
    });
    const highRollerTag = await seedRule('high_roller', { threshold: '10000' });
    await seedActiveAssignment(userId, highRollerTag);

    await service.onDepositCompleted(depositPayload(userId, 100));

    expect(await activeTagKeys(userId)).not.toContain('high_roller');
    const row = await assignmentRow(userId, highRollerTag);
    expect(row?.removedAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({ removalActor: 'scheduled', removalActorUserId: SYSTEM_ACTOR_ID });
  });

  it('does nothing when the rules are disabled', async () => {
    const userId = randomUUID();
    const { service, walletReader } = makeServices();
    await seedRule('high_roller', { threshold: '10000', isEnabled: false });
    await seedRule('large_depositor', { threshold: '100', isEnabled: false });

    await service.onDepositCompleted(depositPayload(userId, 99999));

    expect(await activeTagKeys(userId)).toEqual([]);
    expect(walletReader.getLifetimeDeposit).not.toHaveBeenCalled();
  });
});

describe('TagEvaluationService.onWithdrawalCompleted (real PG)', () => {
  it('assigns high_risk when a single withdrawal meets the amount threshold', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('high_risk', { threshold: '1000' });

    await service.onWithdrawalCompleted(withdrawalPayload(userId, 1500));

    expect(await activeTagKeys(userId)).toContain('high_risk');
  });

  it('assigns high_risk when the withdrawal count in the window meets the threshold', async () => {
    const userId = randomUUID();
    const { service, walletReader } = makeServices({
      walletReader: { getWithdrawalCountInWindow: vi.fn().mockResolvedValue(3) },
    });
    await seedRule('high_risk', { threshold: '1000', thresholdDays: 7, thresholdCount: 3 });

    await service.onWithdrawalCompleted(withdrawalPayload(userId, 10));

    expect(walletReader.getWithdrawalCountInWindow).toHaveBeenCalledWith(userId, 7);
    expect(await activeTagKeys(userId)).toContain('high_risk');
  });

  it('takes no action when neither threshold is met (risk designation requires admin clear)', async () => {
    const userId = randomUUID();
    const { service } = makeServices({
      walletReader: { getWithdrawalCountInWindow: vi.fn().mockResolvedValue(1) },
    });
    await seedRule('high_risk', { threshold: '1000', thresholdDays: 7, thresholdCount: 3 });

    await service.onWithdrawalCompleted(withdrawalPayload(userId, 10));

    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('skips the count check when thresholdDays or thresholdCount is null', async () => {
    const userId = randomUUID();
    const { service, walletReader } = makeServices();
    await seedRule('high_risk', { threshold: '1000', thresholdDays: null });

    await service.onWithdrawalCompleted(withdrawalPayload(userId, 10));

    expect(walletReader.getWithdrawalCountInWindow).not.toHaveBeenCalled();
  });
});

describe('TagEvaluationService.onUserLogin (real PG)', () => {
  it('removes an active inactive-tag assignment when the player logs in', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const inactiveTag = await seedTagRow('inactive');
    await seedActiveAssignment(userId, inactiveTag);

    await service.onUserLogin({ userId });

    expect(await activeTagKeys(userId)).not.toContain('inactive');
    const row = await assignmentRow(userId, inactiveTag);
    expect(row).toMatchObject({ removalActor: 'scheduled', removalActorUserId: SYSTEM_ACTOR_ID });
  });
});

describe('TagEvaluationService.onKycSubmitted (real PG)', () => {
  it('assigns kyc_pending when the rule is enabled', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedKycPendingRule();

    await service.onKycSubmitted({ userId, referenceId: 'ref-1', provider: 'sumsub' });

    expect(await activeTagKeys(userId)).toContain('kyc_pending');
  });

  it('removes an existing kyc_rejected assignment on resubmission', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { kycRejectedTag } = await seedKycPendingRule();
    await seedActiveAssignment(userId, kycRejectedTag);

    await service.onKycSubmitted({ userId, referenceId: 'ref-1', provider: 'sumsub' });

    expect(await activeTagKeys(userId)).toContain('kyc_pending');
    expect(await activeTagKeys(userId)).not.toContain('kyc_rejected');
  });

  it('does nothing when kyc_pending rule is disabled', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('kyc_pending', { isEnabled: false });

    await service.onKycSubmitted({ userId, referenceId: 'ref-1', provider: 'sumsub' });

    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('is idempotent when kyc_pending is already assigned (at-least-once delivery)', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { kycPendingTag } = await seedKycPendingRule();
    await seedActiveAssignment(userId, kycPendingTag);

    await expect(
      service.onKycSubmitted({ userId, referenceId: 'ref-1', provider: 'sumsub' }),
    ).resolves.toBeUndefined();

    const rows = await db.drizzle.db
      .select()
      .from(playerTag)
      .where(and(eq(playerTag.playerId, userId), eq(playerTag.tagId, kycPendingTag.id)));
    expect(rows).toHaveLength(1);
  });
});

describe('TagEvaluationService.onKycStatusUpdated (real PG)', () => {
  it('removes kyc_pending on verified', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { kycPendingTag } = await seedKycPendingRule();
    await seedActiveAssignment(userId, kycPendingTag);

    await service.onKycStatusUpdated(kycUpdatedPayload(userId, 'verified'));

    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('removes kyc_pending and assigns kyc_rejected on rejected', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { kycPendingTag } = await seedKycPendingRule();
    await seedActiveAssignment(userId, kycPendingTag);

    await service.onKycStatusUpdated(kycUpdatedPayload(userId, 'rejected'));

    expect(await activeTagKeys(userId)).toEqual(['kyc_rejected']);
  });

  it('assigns kyc_pending on resubmission_requested', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedKycPendingRule();

    await service.onKycStatusUpdated(kycUpdatedPayload(userId, 'resubmission_requested'));

    expect(await activeTagKeys(userId)).toContain('kyc_pending');
  });

  it('does nothing when kyc_pending rule is disabled', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('kyc_pending', { isEnabled: false });

    await service.onKycStatusUpdated(kycUpdatedPayload(userId, 'verified'));

    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('is idempotent when verified fires twice (tags already removed)', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedKycPendingRule();

    await expect(
      service.onKycStatusUpdated(kycUpdatedPayload(userId, 'verified')),
    ).resolves.toBeUndefined();
    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('is idempotent when rejected fires twice (kyc_pending gone, kyc_rejected already present)', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { kycRejectedTag } = await seedKycPendingRule();
    await seedActiveAssignment(userId, kycRejectedTag);

    await expect(
      service.onKycStatusUpdated(kycUpdatedPayload(userId, 'rejected')),
    ).resolves.toBeUndefined();

    const rows = await db.drizzle.db
      .select()
      .from(playerTag)
      .where(and(eq(playerTag.playerId, userId), eq(playerTag.tagId, kycRejectedTag.id)));
    expect(rows).toHaveLength(1);
  });

  it('is idempotent when resubmission_requested fires twice (kyc_pending already assigned)', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { kycPendingTag } = await seedKycPendingRule();
    await seedActiveAssignment(userId, kycPendingTag);

    await expect(
      service.onKycStatusUpdated(kycUpdatedPayload(userId, 'resubmission_requested')),
    ).resolves.toBeUndefined();

    const rows = await db.drizzle.db
      .select()
      .from(playerTag)
      .where(and(eq(playerTag.playerId, userId), eq(playerTag.tagId, kycPendingTag.id)));
    expect(rows).toHaveLength(1);
  });
});

describe('TagEvaluationService.runDailyEvaluation (real PG)', () => {
  it('assigns inactive to each player returned by the identity reader, exactly once each', async () => {
    const playerA = randomUUID();
    const playerB = randomUUID();
    const inactiveTag = await seedRule('inactive', { thresholdDays: 30 });
    const { service } = makeServices({
      identityReader: { getPlayerIdsInactiveSince: vi.fn().mockResolvedValue([playerA, playerB]) },
    });

    await service.runDailyEvaluation();

    expect(await activeTagKeys(playerA)).toContain('inactive');
    expect(await activeTagKeys(playerB)).toContain('inactive');
    const rows = await db.drizzle.db
      .select()
      .from(playerTag)
      .where(eq(playerTag.tagId, inactiveTag.id));
    expect(rows).toHaveLength(2);
  });

  it('returns early when the rule is disabled', async () => {
    await seedRule('inactive', { thresholdDays: 30, isEnabled: false });
    const { service, identityReader } = makeServices();

    await service.runDailyEvaluation();

    expect(identityReader.getPlayerIdsInactiveSince).not.toHaveBeenCalled();
  });

  it('returns early when thresholdDays is null', async () => {
    await seedRule('inactive', { thresholdDays: null });
    const { service, identityReader } = makeServices();

    await service.runDailyEvaluation();

    expect(identityReader.getPlayerIdsInactiveSince).not.toHaveBeenCalled();
  });
});

describe('TagEvaluationService idempotency (real PG)', () => {
  it('swallows TagAlreadyInUseError when the tag is already active', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const largeDepositorTag = await seedRule('large_depositor', { threshold: '500' });
    await seedActiveAssignment(userId, largeDepositorTag);

    await expect(service.onDepositCompleted(depositPayload(userId, 500))).resolves.toBeUndefined();

    const rows = await db.drizzle.db
      .select()
      .from(playerTag)
      .where(eq(playerTag.tagId, largeDepositorTag.id));
    expect(rows).toHaveLength(1);
  });

  it('swallows TagAssignmentNotFoundError when nothing is assigned to remove', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedTagRow('inactive');

    await expect(service.onUserLogin({ userId })).resolves.toBeUndefined();
    expect(await activeTagKeys(userId)).toEqual([]);
  });
});

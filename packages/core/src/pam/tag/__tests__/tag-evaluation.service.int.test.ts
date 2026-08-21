import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type {
  WalletReader,
  IdentityReader,
  AdminUserDirectory,
  TagKey,
  KycStatus,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { mock, makeEventBus } from '../../../testing/mock.js';
import { TagEvaluationService } from '../service/tag-evaluation.service.js';
import { SYSTEM_ACTOR_ID } from '../contract/index.js';
import { TagService } from '../service/tag.service.js';
import { TagRuleService } from '../service/tag-rule.service.js';
import { migrate } from '../migrate.js';
import { tag, tagRule, playerTag } from '../schema/index.js';
import type { PlayerTagAssignMetadata } from '../contract/index.js';

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
  const kycRejectedTag = await seedRule('kyc_rejected');
  return { kycPendingTag, kycRejectedTag };
}

// onAuthenticatedLogin unconditionally tries to remove BOTH the inactive and
// dormant_high_roller catalog tags on every login - both rows must exist regardless
// of which one (if either) a given test actually cares about.
async function seedLoginCleanupTags() {
  const inactiveTag = await seedTagRow('inactive');
  const dormantTag = await seedTagRow('dormant_high_roller');
  return { inactiveTag, dormantTag };
}

async function seedActiveAssignment(
  playerId: string,
  tagRow: { id: string },
  overrides: { assignReason?: string; assignMetadata?: PlayerTagAssignMetadata | null } = {},
) {
  const [row] = await db.drizzle.db
    .insert(playerTag)
    .values({
      playerId,
      tagId: tagRow.id,
      assignReason: 'seed fixture',
      assignActor: 'manual',
      assignActorUserId: null,
      ...overrides,
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

async function activeAssignmentRow(playerId: string, tagRow: { id: string }) {
  const [row] = await db.drizzle.db
    .select()
    .from(playerTag)
    .where(
      and(
        eq(playerTag.playerId, playerId),
        eq(playerTag.tagId, tagRow.id),
        isNull(playerTag.removedAt),
      ),
    );
  return row;
}

async function seedUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({
      name: 'Player',
      username: `u_${randomUUID().replaceAll('-', '').slice(0, 14)}`,
      email: `${randomUUID()}@example.com`,
      ...overrides,
    })
    .returning();
  return row!;
}

async function seedPlayer(userId: string, overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId, displayName: 'Player', ...overrides })
    .returning();
  return row!;
}

async function seedPlayerWithUser() {
  const account = await seedUser();
  const row = await seedPlayer(account.id);
  return { account, player: row };
}

// Resolves identityReader.getPlayerIdByUserId for a fixed set of (userId, playerId)
// pairs - the real TagService methods that join through the `player` table
// (getActiveTagKeys, listActiveHoldersByTagKey) need actual player rows, so those
// tests seed a real player and must resolve to its real id, not just echo the userId.
function identityLookup(pairs: ReadonlyArray<readonly [string, string]>) {
  const map = new Map(pairs);
  return vi.fn(async (uid: string) => map.get(uid) ?? null);
}

function makeServices(
  overrides: {
    walletReader?: Partial<WalletReader>;
    identityReader?: Partial<IdentityReader>;
    adminUserDirectory?: Partial<AdminUserDirectory>;
  } = {},
) {
  const events = makeEventBus();
  const tagService = new TagService(db.drizzle, events);
  const ruleService = new TagRuleService(db.drizzle, events);
  const walletReader = mock<WalletReader>({
    getLifetimeDeposit: vi.fn().mockResolvedValue('0'),
    getWithdrawalCountInWindow: vi.fn().mockResolvedValue(0),
    getWithdrawalCountsInWindow: vi.fn().mockResolvedValue(new Map()),
    ...overrides.walletReader,
  });
  const identityReader = mock<IdentityReader>({
    getLastLoginAt: vi.fn().mockResolvedValue(null),
    getPlayerIdsInactiveSince: vi.fn().mockResolvedValue([]),
    getPlayerIdByUserId: vi.fn(async (uid: string) => uid),
    getPlayerIdByUserIdSafe: vi.fn(async (uid: string) => uid),
    getPlayerKycStatusByUserId: vi.fn().mockResolvedValue('pending'),
    getPlayerUserIdsSharingLoginIp: vi.fn().mockResolvedValue([]),
    ...overrides.identityReader,
  });
  const adminUserDirectory = mock<AdminUserDirectory>({
    lookupPlayers: vi.fn().mockResolvedValue([]),
    ...overrides.adminUserDirectory,
  });
  const service = new TagEvaluationService({
    tag: tagService,
    rule: ruleService,
    walletReader,
    identityReader,
    adminUserDirectory,
  });
  return { service, tagService, ruleService, walletReader, identityReader, adminUserDirectory };
}

function depositPayload(userId: string, amount: number) {
  return {
    userId,
    playerId: null,
    amount: String(amount),
    currency: 'USD',
    transactionId: randomUUID(),
  };
}
function withdrawalPayload(userId: string, amount: number) {
  return {
    userId,
    playerId: null,
    amount: String(amount),
    currency: 'USD',
    transactionId: randomUUID(),
  };
}
function kycUpdatedPayload(userId: string, status: KycStatus) {
  return {
    userId,
    playerId: null,
    actorId: SYSTEM_ACTOR_ID,
    status,
    previousStatus: 'pending',
    reason: null,
    source: 'webhook',
  };
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tagRule}, ${tag}, ${player}, ${user} RESTART IDENTITY CASCADE`,
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
  it('assigns high_risk when a single withdrawal meets the amount threshold, recording the amount breach detail', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const highRisk = await seedRule('high_risk', { threshold: '1000' });

    await service.onWithdrawalCompleted(withdrawalPayload(userId, 1500));

    expect(await activeTagKeys(userId)).toContain('high_risk');
    const row = await assignmentRow(userId, highRisk);
    expect(row?.assignMetadata).toEqual({
      amountBreach: { amount: '1500', threshold: '1000.00' },
      countBreach: null,
    });
  });

  it('assigns high_risk when the withdrawal count in the window meets the threshold, recording the count breach detail', async () => {
    const userId = randomUUID();
    const { service, walletReader } = makeServices({
      walletReader: { getWithdrawalCountInWindow: vi.fn().mockResolvedValue(3) },
    });
    const highRisk = await seedRule('high_risk', {
      threshold: '1000',
      thresholdDays: 7,
      thresholdCount: 3,
    });

    await service.onWithdrawalCompleted(withdrawalPayload(userId, 10));

    expect(walletReader.getWithdrawalCountInWindow).toHaveBeenCalledWith(userId, 7);
    const row = await assignmentRow(userId, highRisk);
    expect(row?.assignMetadata).toEqual({
      amountBreach: null,
      countBreach: { count: 3, thresholdCount: 3, thresholdDays: 7 },
    });
  });

  it('records both breach details when both amount and frequency thresholds are met', async () => {
    const userId = randomUUID();
    const { service } = makeServices({
      walletReader: { getWithdrawalCountInWindow: vi.fn().mockResolvedValue(5) },
    });
    const highRisk = await seedRule('high_risk', {
      threshold: '1000',
      thresholdDays: 7,
      thresholdCount: 3,
    });

    await service.onWithdrawalCompleted(withdrawalPayload(userId, 1500));

    const row = await assignmentRow(userId, highRisk);
    expect(row?.assignMetadata).toEqual({
      amountBreach: { amount: '1500', threshold: '1000.00' },
      countBreach: { count: 5, thresholdCount: 3, thresholdDays: 7 },
    });
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

describe('TagEvaluationService.onWithdrawalRequested (real PG)', () => {
  it('assigns withdrawal_review when the withdrawal amount meets the threshold', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('withdrawal_review', { threshold: '5000' });

    await service.onWithdrawalRequested(withdrawalPayload(userId, 5000));

    expect(await activeTagKeys(userId)).toContain('withdrawal_review');
  });

  it('does not assign withdrawal_review when the amount is below threshold', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('withdrawal_review', { threshold: '5000' });

    await service.onWithdrawalRequested(withdrawalPayload(userId, 4999));

    expect(await activeTagKeys(userId)).not.toContain('withdrawal_review');
  });

  it('does nothing when the rule is disabled', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('withdrawal_review', { threshold: '5000', isEnabled: false });

    await service.onWithdrawalRequested(withdrawalPayload(userId, 99999));

    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('does nothing when the rule is absent', async () => {
    const userId = randomUUID();
    const { service } = makeServices();

    await service.onWithdrawalRequested(withdrawalPayload(userId, 99999));

    expect(await activeTagKeys(userId)).toEqual([]);
  });
});

describe('TagEvaluationService.evaluateWithdrawalRequested (real PG)', () => {
  it('assigns withdrawal_review on the caller-supplied tx when the amount meets threshold', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('withdrawal_review', { threshold: '5000' });

    await db.drizzle.db.transaction(async (trx) => {
      await service.evaluateWithdrawalRequested(trx, { userId, amount: '5000' });
    });

    expect(await activeTagKeys(userId)).toContain('withdrawal_review');
  });

  it('does not assign when the amount is below threshold', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('withdrawal_review', { threshold: '5000' });

    await db.drizzle.db.transaction(async (trx) => {
      await service.evaluateWithdrawalRequested(trx, { userId, amount: '4999' });
    });

    expect(await activeTagKeys(userId)).not.toContain('withdrawal_review');
  });

  it('does nothing when the rule is disabled or absent', async () => {
    const userId = randomUUID();
    const { service } = makeServices();

    await db.drizzle.db.transaction(async (trx) => {
      await service.evaluateWithdrawalRequested(trx, { userId, amount: '99999' });
    });

    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('is idempotent - swallows TagAlreadyInUseError when already assigned', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('withdrawal_review', { threshold: '5000' });

    await expect(
      db.drizzle.db.transaction(async (trx) => {
        await service.evaluateWithdrawalRequested(trx, { userId, amount: '5000' });
        await service.evaluateWithdrawalRequested(trx, { userId, amount: '5000' });
      }),
    ).resolves.toBeUndefined();

    const rows = await db.drizzle.db.select().from(playerTag);
    expect(rows).toHaveLength(1);
  });

  it('propagates an unexpected error (fail-closed: a review-gate failure must block the caller, not silently skip review)', async () => {
    const userId = randomUUID();
    const { service, tagService } = makeServices();
    await seedRule('withdrawal_review', { threshold: '5000' });
    vi.spyOn(tagService, 'assignPlayerTagInTx').mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      db.drizzle.db.transaction(async (trx) => {
        await service.evaluateWithdrawalRequested(trx, { userId, amount: '5000' });
      }),
    ).rejects.toThrow('db unavailable');
  });
});

describe('TagEvaluationService.onUserLogin (real PG)', () => {
  it('removes an active inactive-tag assignment when the player logs in', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { inactiveTag } = await seedLoginCleanupTags();
    await seedActiveAssignment(userId, inactiveTag);

    await service.onUserLogin({ userId, playerId: null });

    expect(await activeTagKeys(userId)).not.toContain('inactive');
    const row = await assignmentRow(userId, inactiveTag);
    expect(row).toMatchObject({ removalActor: 'scheduled', removalActorUserId: SYSTEM_ACTOR_ID });
  });

  it('removes an active dormant_high_roller assignment when the player logs in', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { dormantTag } = await seedLoginCleanupTags();
    await seedActiveAssignment(userId, dormantTag);

    await service.onUserLogin({ userId, playerId: null });

    expect(await activeTagKeys(userId)).not.toContain('dormant_high_roller');
  });

  it('is idempotent when dormant_high_roller was never assigned', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedLoginCleanupTags();

    await expect(service.onUserLogin({ userId, playerId: null })).resolves.toBeUndefined();
  });

  it('assigns multi_account and bonus_abuser to both player accounts when login IP is shared', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const { service, identityReader } = makeServices({
      identityReader: { getPlayerUserIdsSharingLoginIp: vi.fn().mockResolvedValue([otherUserId]) },
    });
    await seedLoginCleanupTags();
    await seedRule('multi_account');
    await seedRule('bonus_abuser');

    await service.onUserLogin({ userId, playerId: null, ip: '203.0.113.10', userAgent: null });

    expect(identityReader.getPlayerUserIdsSharingLoginIp).toHaveBeenCalledWith(
      userId,
      '203.0.113.10',
    );
    expect(await activeTagKeys(userId)).toEqual(
      expect.arrayContaining(['multi_account', 'bonus_abuser']),
    );
    expect(await activeTagKeys(otherUserId)).toEqual(
      expect.arrayContaining(['multi_account', 'bonus_abuser']),
    );
  });

  it('does not evaluate shared-IP risk when login has no IP metadata', async () => {
    const userId = randomUUID();
    const { service, identityReader } = makeServices();
    await seedLoginCleanupTags();
    await seedRule('multi_account');
    await seedRule('bonus_abuser');

    await service.onUserLogin({ userId, playerId: null });

    expect(identityReader.getPlayerUserIdsSharingLoginIp).not.toHaveBeenCalled();
  });

  it('uses the same shared-IP risk path for phone login', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const { service, identityReader } = makeServices({
      identityReader: { getPlayerUserIdsSharingLoginIp: vi.fn().mockResolvedValue([otherUserId]) },
    });
    await seedLoginCleanupTags();
    await seedRule('multi_account');
    await seedRule('bonus_abuser');

    await service.onUserPhoneLogin({
      userId,
      playerId: null,
      method: 'phone',
      ip: '203.0.113.11',
      userAgent: null,
    });

    expect(identityReader.getPlayerUserIdsSharingLoginIp).toHaveBeenCalledWith(
      userId,
      '203.0.113.11',
    );
    expect(await activeTagKeys(userId)).toContain('multi_account');
    expect(await activeTagKeys(otherUserId)).toContain('bonus_abuser');
  });
});

describe('TagEvaluationService.onKycSubmitted (real PG)', () => {
  it('assigns kyc_pending when the rule is enabled', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedKycPendingRule();

    await service.onKycSubmitted({
      userId,
      playerId: null,
      referenceId: 'ref-1',
      provider: 'sumsub',
    });

    expect(await activeTagKeys(userId)).toContain('kyc_pending');
  });

  it('keeps kyc_rejected sticky on the resubmission path', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { kycRejectedTag } = await seedKycPendingRule();
    await seedActiveAssignment(userId, kycRejectedTag);

    await service.onKycSubmitted({
      userId,
      playerId: null,
      referenceId: 'ref-1',
      provider: 'sumsub',
    });

    expect(await activeTagKeys(userId)).toContain('kyc_pending');
    expect(await activeTagKeys(userId)).toContain('kyc_rejected');
  });

  it('does not assign kyc_pending when the profile status is already terminal', async () => {
    const userId = randomUUID();
    const { service } = makeServices({
      identityReader: { getPlayerKycStatusByUserId: vi.fn().mockResolvedValue('verified') },
    });
    await seedKycPendingRule();

    await service.onKycSubmitted({
      userId,
      playerId: null,
      referenceId: 'ref-1',
      provider: 'sumsub',
    });

    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('does nothing when kyc_pending rule is disabled', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('kyc_pending', { isEnabled: false });

    await service.onKycSubmitted({
      userId,
      playerId: null,
      referenceId: 'ref-1',
      provider: 'sumsub',
    });

    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('is idempotent when kyc_pending is already assigned (at-least-once delivery)', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { kycPendingTag } = await seedKycPendingRule();
    await seedActiveAssignment(userId, kycPendingTag);

    await expect(
      service.onKycSubmitted({ userId, playerId: null, referenceId: 'ref-1', provider: 'sumsub' }),
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

  it('assigns kyc_pending and keeps kyc_rejected on resubmission_requested', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const { kycRejectedTag } = await seedKycPendingRule();
    await seedActiveAssignment(userId, kycRejectedTag);

    await service.onKycStatusUpdated(kycUpdatedPayload(userId, 'resubmission_requested'));

    expect(await activeTagKeys(userId)).toEqual(
      expect.arrayContaining(['kyc_pending', 'kyc_rejected']),
    );
  });

  it('does not assign kyc_pending on resubmission_requested when the rule is disabled', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('kyc_pending', { isEnabled: false });

    await service.onKycStatusUpdated(kycUpdatedPayload(userId, 'resubmission_requested'));

    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('does not assign kyc_rejected when the rejected rule is disabled', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const kycPendingTag = await seedRule('kyc_pending');
    await seedActiveAssignment(userId, kycPendingTag);
    await seedRule('kyc_rejected', { isEnabled: false });

    await service.onKycStatusUpdated(kycUpdatedPayload(userId, 'rejected'));

    expect(await activeTagKeys(userId)).toEqual([]);
  });

  it('does nothing when kyc_pending rule is disabled', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedRule('kyc_pending', { isEnabled: false });
    await seedTagRow('kyc_rejected');

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

  describe('dormant_high_roller sweep (real PG)', () => {
    it('assigns to inactive users who also hold high_roller', async () => {
      const { account: a1, player: p1 } = await seedPlayerWithUser();
      const { account: a2, player: p2 } = await seedPlayerWithUser();
      const highRoller = await seedTagRow('high_roller');
      await seedActiveAssignment(p1.id, highRoller);
      const kycPending = await seedTagRow('kyc_pending');
      await seedActiveAssignment(p2.id, kycPending);
      await seedRule('dormant_high_roller', { thresholdDays: 60 });
      const { service } = makeServices({
        identityReader: {
          getPlayerIdsInactiveSince: vi.fn().mockResolvedValue([a1.id, a2.id]),
          getPlayerIdByUserId: identityLookup([
            [a1.id, p1.id],
            [a2.id, p2.id],
          ]),
        },
      });

      await service.runDailyEvaluation();

      expect(await activeTagKeys(p1.id)).toContain('dormant_high_roller');
      expect(await activeTagKeys(p2.id)).not.toContain('dormant_high_roller');
    });

    it('does not assign to inactive users without high_roller', async () => {
      const { account, player: seededPlayer } = await seedPlayerWithUser();
      const vip = await seedTagRow('vip');
      await seedActiveAssignment(seededPlayer.id, vip);
      await seedRule('dormant_high_roller', { thresholdDays: 60 });
      const { service } = makeServices({
        identityReader: {
          getPlayerIdsInactiveSince: vi.fn().mockResolvedValue([account.id]),
          getPlayerIdByUserId: identityLookup([[account.id, seededPlayer.id]]),
        },
      });

      await service.runDailyEvaluation();

      expect(await activeTagKeys(seededPlayer.id)).not.toContain('dormant_high_roller');
    });

    it('does nothing when the rule is disabled', async () => {
      await seedRule('dormant_high_roller', { thresholdDays: 60, isEnabled: false });
      const { service, identityReader } = makeServices();

      await service.runDailyEvaluation();

      expect(identityReader.getPlayerIdsInactiveSince).not.toHaveBeenCalled();
    });

    it('does nothing when thresholdDays is null', async () => {
      await seedRule('dormant_high_roller', { thresholdDays: null });
      const { service, identityReader } = makeServices();

      await service.runDailyEvaluation();

      expect(identityReader.getPlayerIdsInactiveSince).not.toHaveBeenCalled();
    });
  });

  describe('high_risk resweep (real PG)', () => {
    const countOnlyMetadata: PlayerTagAssignMetadata = {
      amountBreach: null,
      countBreach: { count: 3, thresholdCount: 3, thresholdDays: 7 },
    };
    const amountBreachMetadata: PlayerTagAssignMetadata = {
      amountBreach: { amount: '2000', threshold: '1000' },
      countBreach: null,
    };

    async function seedHighRiskHolder(
      highRiskTag: { id: string },
      metadata: PlayerTagAssignMetadata | null,
    ) {
      const { account, player: seededPlayer } = await seedPlayerWithUser();
      await seedActiveAssignment(seededPlayer.id, highRiskTag, { assignMetadata: metadata });
      return { account, player: seededPlayer };
    }

    it('removes the tag from a holder when the recheck shows count below threshold', async () => {
      const highRisk = await seedRule('high_risk', {
        threshold: '1000',
        thresholdDays: 7,
        thresholdCount: 3,
      });
      const { account, player: seededPlayer } = await seedHighRiskHolder(
        highRisk,
        countOnlyMetadata,
      );
      const { service, walletReader } = makeServices({
        walletReader: {
          getWithdrawalCountsInWindow: vi.fn().mockResolvedValue(new Map([[account.id, 1]])),
        },
        identityReader: { getPlayerIdByUserId: identityLookup([[account.id, seededPlayer.id]]) },
      });

      await service.runDailyEvaluation();

      expect(walletReader.getWithdrawalCountsInWindow).toHaveBeenCalledWith([account.id], 7);
      expect(await activeTagKeys(seededPlayer.id)).not.toContain('high_risk');
    });

    it('keeps the tag when the count is still at or above threshold', async () => {
      const highRisk = await seedRule('high_risk', {
        threshold: '1000',
        thresholdDays: 7,
        thresholdCount: 3,
      });
      const { account, player: seededPlayer } = await seedHighRiskHolder(
        highRisk,
        countOnlyMetadata,
      );
      const { service } = makeServices({
        walletReader: {
          getWithdrawalCountsInWindow: vi.fn().mockResolvedValue(new Map([[account.id, 3]])),
        },
        identityReader: { getPlayerIdByUserId: identityLookup([[account.id, seededPlayer.id]]) },
      });

      await service.runDailyEvaluation();

      expect(await activeTagKeys(seededPlayer.id)).toContain('high_risk');
    });

    it('treats a holder absent from the batched result as zero and removes the tag', async () => {
      const highRisk = await seedRule('high_risk', {
        threshold: '1000',
        thresholdDays: 7,
        thresholdCount: 3,
      });
      const { account, player: seededPlayer } = await seedHighRiskHolder(
        highRisk,
        countOnlyMetadata,
      );
      const { service } = makeServices({
        walletReader: { getWithdrawalCountsInWindow: vi.fn().mockResolvedValue(new Map()) },
        identityReader: { getPlayerIdByUserId: identityLookup([[account.id, seededPlayer.id]]) },
      });

      await service.runDailyEvaluation();

      expect(await activeTagKeys(seededPlayer.id)).not.toContain('high_risk');
    });

    it('skips entirely when thresholdDays is null (amount-only rule, not resweepable)', async () => {
      await seedRule('high_risk', { threshold: '1000', thresholdDays: null, thresholdCount: 3 });
      const { service, walletReader } = makeServices();

      await service.runDailyEvaluation();

      expect(walletReader.getWithdrawalCountsInWindow).not.toHaveBeenCalled();
    });

    it('skips entirely when thresholdCount is null (no frequency dimension to resweep)', async () => {
      await seedRule('high_risk', { threshold: '1000', thresholdDays: 7, thresholdCount: null });
      const { service, walletReader } = makeServices();

      await service.runDailyEvaluation();

      expect(walletReader.getWithdrawalCountsInWindow).not.toHaveBeenCalled();
    });

    it('skips when the rule is disabled', async () => {
      await seedRule('high_risk', {
        threshold: '1000',
        thresholdDays: 7,
        thresholdCount: 3,
        isEnabled: false,
      });
      const { service, walletReader } = makeServices();

      await service.runDailyEvaluation();

      expect(walletReader.getWithdrawalCountsInWindow).not.toHaveBeenCalled();
    });

    it('does nothing when there are no holders', async () => {
      await seedRule('high_risk', { threshold: '1000', thresholdDays: 7, thresholdCount: 3 });
      const { service, walletReader } = makeServices();

      await service.runDailyEvaluation();

      expect(walletReader.getWithdrawalCountsInWindow).not.toHaveBeenCalled();
    });

    it('falls back to per-holder getWithdrawalCountInWindow when the batched method is absent from the adapter', async () => {
      const highRisk = await seedRule('high_risk', {
        threshold: '1000',
        thresholdDays: 7,
        thresholdCount: 3,
      });
      const { account: a1, player: p1 } = await seedHighRiskHolder(highRisk, countOnlyMetadata);
      const { account: a2, player: p2 } = await seedHighRiskHolder(highRisk, countOnlyMetadata);
      const { service, walletReader } = makeServices({
        // Simulate an external WalletReader implementation that predates the batched method.
        walletReader: {
          getWithdrawalCountsInWindow: undefined,
          getWithdrawalCountInWindow: vi.fn(async (userId: string) => (userId === a1.id ? 1 : 5)),
        },
        identityReader: {
          getPlayerIdByUserId: identityLookup([
            [a1.id, p1.id],
            [a2.id, p2.id],
          ]),
        },
      });

      await service.runDailyEvaluation();

      expect(walletReader.getWithdrawalCountInWindow).toHaveBeenCalledWith(a1.id, 7);
      expect(walletReader.getWithdrawalCountInWindow).toHaveBeenCalledWith(a2.id, 7);
      expect(await activeTagKeys(p1.id)).not.toContain('high_risk');
      expect(await activeTagKeys(p2.id)).toContain('high_risk');
    });

    it('does not remove a holder whose assignMetadata shows an amount breach, even when the windowed count is below threshold (bug-fix case)', async () => {
      const highRisk = await seedRule('high_risk', {
        threshold: '1000',
        thresholdDays: 7,
        thresholdCount: 3,
      });
      const { account, player: seededPlayer } = await seedHighRiskHolder(
        highRisk,
        amountBreachMetadata,
      );
      const { service } = makeServices({
        walletReader: {
          getWithdrawalCountsInWindow: vi.fn().mockResolvedValue(new Map([[account.id, 0]])),
        },
        identityReader: { getPlayerIdByUserId: identityLookup([[account.id, seededPlayer.id]]) },
      });

      await service.runDailyEvaluation();

      expect(await activeTagKeys(seededPlayer.id)).toContain('high_risk');
    });

    it('still removes a count-only-breach holder whose windowed count drops below threshold (existing behavior preserved)', async () => {
      const highRisk = await seedRule('high_risk', {
        threshold: '1000',
        thresholdDays: 7,
        thresholdCount: 3,
      });
      const { account, player: seededPlayer } = await seedHighRiskHolder(
        highRisk,
        countOnlyMetadata,
      );
      const { service } = makeServices({
        walletReader: {
          getWithdrawalCountsInWindow: vi.fn().mockResolvedValue(new Map([[account.id, 1]])),
        },
        identityReader: { getPlayerIdByUserId: identityLookup([[account.id, seededPlayer.id]]) },
      });

      await service.runDailyEvaluation();

      expect(await activeTagKeys(seededPlayer.id)).not.toContain('high_risk');
    });

    it('does not remove a holder with null assignMetadata (legacy row), even when below threshold', async () => {
      const highRisk = await seedRule('high_risk', {
        threshold: '1000',
        thresholdDays: 7,
        thresholdCount: 3,
      });
      const { account, player: seededPlayer } = await seedHighRiskHolder(highRisk, null);
      const { service } = makeServices({
        walletReader: {
          getWithdrawalCountsInWindow: vi.fn().mockResolvedValue(new Map([[account.id, 0]])),
        },
        identityReader: { getPlayerIdByUserId: identityLookup([[account.id, seededPlayer.id]]) },
      });

      await service.runDailyEvaluation();

      expect(await activeTagKeys(seededPlayer.id)).toContain('high_risk');
    });
  });
});

describe('TagEvaluationService.onSelfExclusionActivated / onSelfExclusionLifted (real PG)', () => {
  it('assigns self_excluded', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedTagRow('self_excluded');

    await service.onSelfExclusionActivated({
      userId,
      playerId: null,
      actorId: SYSTEM_ACTOR_ID,
      reason: 'player requested self-exclusion',
      exclusionId: randomUUID(),
      isPermanent: false,
      durationMonths: 6,
      expiresAt: new Date().toISOString(),
    });

    expect(await activeTagKeys(userId)).toContain('self_excluded');
  });

  it('is idempotent when self_excluded is already assigned', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const selfExcluded = await seedTagRow('self_excluded');
    await seedActiveAssignment(userId, selfExcluded);

    await expect(
      service.onSelfExclusionActivated({
        userId,
        playerId: null,
        actorId: SYSTEM_ACTOR_ID,
        reason: 'player requested self-exclusion',
        exclusionId: randomUUID(),
        isPermanent: false,
        durationMonths: 6,
        expiresAt: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('removes self_excluded', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const selfExcluded = await seedTagRow('self_excluded');
    await seedActiveAssignment(userId, selfExcluded);

    await service.onSelfExclusionLifted({
      userId,
      playerId: null,
      actorId: SYSTEM_ACTOR_ID,
      reason: 'exclusion period expired',
      exclusionId: randomUUID(),
      kind: 'self_exclusion',
    });

    expect(await activeTagKeys(userId)).not.toContain('self_excluded');
  });

  it('is idempotent when self_excluded was never assigned', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    await seedTagRow('self_excluded');

    await expect(
      service.onSelfExclusionLifted({
        userId,
        playerId: null,
        actorId: SYSTEM_ACTOR_ID,
        reason: 'exclusion period expired',
        exclusionId: randomUUID(),
        kind: 'self_exclusion',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('TagEvaluationService.onPlayerLevelChanged (real PG)', () => {
  it('atomically replaces the level tag with the new level in the assign reason', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const levelTag = await seedTagRow('level');
    await seedActiveAssignment(userId, levelTag, { assignReason: 'player level set to 3' });

    await service.onPlayerLevelChanged({
      userId,
      playerId: null,
      previousLevel: 3,
      newLevel: 4,
      actorId: SYSTEM_ACTOR_ID,
    });

    const row = await activeAssignmentRow(userId, levelTag);
    expect(row).toMatchObject({
      assignReason: 'player level set to 4',
      assignActor: 'scheduled',
      assignActorUserId: SYSTEM_ACTOR_ID,
    });
  });

  it('swallows TagAlreadyInUseError when a concurrent replace wins the race', async () => {
    const userId = randomUUID();
    const { service } = makeServices();
    const levelTag = await seedTagRow('level');

    await expect(
      Promise.all([
        service.onPlayerLevelChanged({
          userId,
          playerId: null,
          previousLevel: 0,
          newLevel: 1,
          actorId: SYSTEM_ACTOR_ID,
        }),
        service.onPlayerLevelChanged({
          userId,
          playerId: null,
          previousLevel: 0,
          newLevel: 2,
          actorId: SYSTEM_ACTOR_ID,
        }),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    const rows = await db.drizzle.db
      .select()
      .from(playerTag)
      .where(
        and(
          eq(playerTag.playerId, userId),
          eq(playerTag.tagId, levelTag.id),
          isNull(playerTag.removedAt),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('rethrows unexpected errors from the replace', async () => {
    const userId = randomUUID();
    const { service, tagService } = makeServices();
    await seedTagRow('level');
    vi.spyOn(tagService, 'replacePlayerTag').mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      service.onPlayerLevelChanged({
        userId,
        playerId: null,
        previousLevel: 0,
        newLevel: 1,
        actorId: SYSTEM_ACTOR_ID,
      }),
    ).rejects.toThrow('connection lost');
  });

  it('is a no-op when the playerId is unknown to the identity reader', async () => {
    const userId = randomUUID();
    const { service, tagService } = makeServices({
      identityReader: { getPlayerIdByUserId: vi.fn().mockResolvedValue(null) },
    });
    const replaceSpy = vi.spyOn(tagService, 'replacePlayerTag');

    await expect(
      service.onPlayerLevelChanged({
        userId,
        playerId: null,
        previousLevel: 3,
        newLevel: 4,
        actorId: SYSTEM_ACTOR_ID,
      }),
    ).resolves.toBeUndefined();
    expect(replaceSpy).not.toHaveBeenCalled();
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
    await seedLoginCleanupTags();

    await expect(service.onUserLogin({ userId, playerId: null })).resolves.toBeUndefined();
    expect(await activeTagKeys(userId)).toEqual([]);
  });
});

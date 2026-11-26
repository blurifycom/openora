import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type {
  AdminUserDirectory,
  AuditWritePort,
  IdentityReader,
  PlayEligibilityPort,
  TagKey,
  UpsertTagRuleInput,
} from '@openora/core/contracts';
import type { EventBus } from '@openora/core/server';
import { createTestDb, type TestDb } from '../../../testing/real-infra.js';
import { seedPlayerWithUser } from '../../../testing/seed-player.js';
import { seedCompletedDeposit } from '../../../testing/seed-wallet.js';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { player } from '@openora/core/pam/schema/profile';
import { WalletReaderService } from '@openora/core/wallet/seed';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateTag } from '../migrate.js';
import { SYSTEM_ACTOR_ID } from '../contract/index.js';
import { playerTag, tag, tagRule } from '../schema/index.js';
import { seedTags } from '../seed/seed-default-tags.js';
import { PlayerNotFoundError, TagAlreadyInUseError, TagService } from '../service/tag.service.js';
import { TagEvaluationService } from '../service/tag-evaluation.service.js';
import { TagRuleService } from '../service/tag-rule.service.js';

type AuditInput = Parameters<AuditWritePort['record']>[0];

const ADMIN_ID = randomUUID();

const events: EventBus = {
  emit() {},
  emitRaw() {},
  async emitInTransaction() {},
  on: () => () => {},
  tapTransactional() {},
};

const noDirectory: AdminUserDirectory = {
  count: async () => 0,
  list: async () => ({ rows: [], total: 0 }),
  get: async () => null,
  lookupUsers: async () => [],
  update: async () => null,
  lookupPlayers: async () => [],
  findPlayerIds: async () => [],
  findUserIdsByKycStatus: async () => [],
  getPlayerByUsername: async () => null,
};

const unrestricted: PlayEligibilityPort = { isRestricted: async () => false };

let testDb: TestDb;

function identityReaderOver(source: TestDb): IdentityReader {
  const playerIdOf = async (userId: string) => {
    const [row] = await source.drizzle.db
      .select({ id: player.id })
      .from(player)
      .where(eq(player.userId, userId));
    return row?.id ?? null;
  };
  return {
    getLastLoginAt: async () => null,
    getPlayerIdsInactiveSince: async () => [],
    getPlayerIdByUserId: playerIdOf,
    getPlayerIdByUserIdSafe: playerIdOf,
    getPlayerIdsByUserIdsSafe: async (userIds) =>
      new Map(await Promise.all(userIds.map(async (id) => [id, await playerIdOf(id)] as const))),
    getPlayerKycStatusByUserId: async () => null,
    getPlayerUserIdsSharingLoginIp: async () => [],
  };
}

let tags: TagService;
let rules: TagRuleService;
let evaluation: TagEvaluationService;
const auditTrail: AuditInput[] = [];

beforeAll(async () => {
  testDb = await createTestDb([migrateIdentity, migrateProfile, migrateTag, migrateWallet]);
  await seedTags(testDb.drizzle.db);
  const audit: AuditWritePort = {
    record: async (entry) => {
      auditTrail.push(entry);
    },
    recordInTransaction: async (_tx, entry) => {
      auditTrail.push(entry);
    },
    recordManyInTransaction: async (_tx, entries) => {
      auditTrail.push(...entries);
    },
  };
  tags = new TagService(testDb.drizzle, events, unrestricted, audit);
  rules = new TagRuleService(testDb.drizzle, events);
  evaluation = new TagEvaluationService({
    tag: tags,
    rule: rules,
    walletReader: new WalletReaderService({ drizzle: testDb.drizzle, pivotCurrency: 'USD' }),
    identityReader: identityReaderOver(testDb),
    adminUserDirectory: noDirectory,
  });
}, 120_000);

afterAll(() => testDb.drop());

const db = () => testDb.drizzle.db;

async function setRule(
  tagKey: TagKey,
  patch: Partial<Omit<UpsertTagRuleInput, 'tagKey'>> = {},
): Promise<void> {
  await rules.upsertTagRule(
    {
      tagKey,
      isEnabled: true,
      threshold: null,
      thresholdDays: null,
      thresholdCount: null,
      ...patch,
    },
    ADMIN_ID,
  );
}

async function dropRule(tagKey: TagKey): Promise<void> {
  const [row] = await db().select({ id: tag.id }).from(tag).where(eq(tag.key, tagKey));
  if (row) {
    await db().delete(tagRule).where(eq(tagRule.tagId, row.id));
  }
}

async function newPlayer() {
  const { player } = await seedPlayerWithUser(testDb);
  return { userId: player.userId, playerId: player.id };
}

function assignmentsOf(playerId: string, tagKey: TagKey) {
  return db()
    .select({
      id: playerTag.id,
      removedAt: playerTag.removedAt,
      assignActor: playerTag.assignActor,
      assignActorUserId: playerTag.assignActorUserId,
      assignReason: playerTag.assignReason,
      removalActor: playerTag.removalActor,
      removalReason: playerTag.removalReason,
    })
    .from(playerTag)
    .innerJoin(tag, eq(tag.id, playerTag.tagId))
    .where(and(eq(playerTag.playerId, playerId), eq(tag.key, tagKey)));
}

async function activeOf(playerId: string, tagKey: TagKey) {
  return (await assignmentsOf(playerId, tagKey)).filter((row) => row.removedAt === null);
}

const auditOf = (playerId: string, action: AuditInput['action'], tagKey?: TagKey) =>
  auditTrail.filter(
    (entry) =>
      entry.resourceId === playerId &&
      entry.action === action &&
      (tagKey === undefined || entry.after?.['tagKey'] === tagKey),
  );

const depositEvent = (userId: string, playerId: string, amount: string) => ({
  userId,
  playerId,
  amount,
  currency: 'USD',
  transactionId: randomUUID(),
});

const withdrawalEvent = (userId: string, playerId: string, amount: string) => ({
  userId,
  playerId,
  amount,
  currency: 'USD',
  transactionId: randomUUID(),
});

describe('tag evaluation', () => {
  it('an enabled rule assigns the tag when the player metric meets the threshold', async () => {
    await setRule('large_depositor', { threshold: '100' });
    const meets = await newPlayer();
    const under = await newPlayer();

    await evaluation.onDepositCompleted(depositEvent(meets.userId, meets.playerId, '100'));
    await evaluation.onDepositCompleted(depositEvent(under.userId, under.playerId, '99.99'));

    const active = await activeOf(meets.playerId, 'large_depositor');
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      assignActor: 'scheduled',
      assignActorUserId: SYSTEM_ACTOR_ID,
      assignReason: 'single deposit crossed threshold',
    });
    expect(await assignmentsOf(under.playerId, 'large_depositor')).toEqual([]);
    expect(auditOf(meets.playerId, 'tag.player.assigned', 'large_depositor')).toEqual([
      expect.objectContaining({ actorType: 'system', actorId: SYSTEM_ACTOR_ID }),
    ]);
  });

  it('a disabled or missing rule is ignored without throwing', async () => {
    const holder = await newPlayer();
    await seedCompletedDeposit(testDb, holder.userId, '1000000');
    await setRule('large_depositor', { isEnabled: false, threshold: '1' });
    await dropRule('high_roller');

    await expect(
      evaluation.onDepositCompleted(depositEvent(holder.userId, holder.playerId, '5000')),
    ).resolves.toBeUndefined();

    expect(await assignmentsOf(holder.playerId, 'large_depositor')).toEqual([]);
    expect(await assignmentsOf(holder.playerId, 'high_roller')).toEqual([]);
    expect(auditOf(holder.playerId, 'tag.player.assigned')).toEqual([]);
  });

  it('an assigned non sticky tag is removed when the metric falls under the threshold', async () => {
    const holder = await newPlayer();
    await seedCompletedDeposit(testDb, holder.userId, '1500');
    await setRule('high_roller', { threshold: '1000' });
    await evaluation.onDepositCompleted(depositEvent(holder.userId, holder.playerId, '1500'));
    expect(await activeOf(holder.playerId, 'high_roller')).toHaveLength(1);

    await setRule('high_roller', { threshold: '5000' });
    await evaluation.onDepositCompleted(depositEvent(holder.userId, holder.playerId, '1'));

    expect(await activeOf(holder.playerId, 'high_roller')).toEqual([]);
    const history = await assignmentsOf(holder.playerId, 'high_roller');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      removalActor: 'scheduled',
      removalReason: 'lifetime deposits below threshold',
    });
    expect(history[0]?.removedAt).toBeInstanceOf(Date);
    expect(auditOf(holder.playerId, 'tag.player.removed', 'high_roller')).toEqual([
      expect.objectContaining({ actorType: 'system', actorId: SYSTEM_ACTOR_ID }),
    ]);
  });

  it('a sticky tag is kept when the metric falls under the threshold', async () => {
    const holder = await newPlayer();
    await setRule('withdrawal_review', { threshold: '100' });
    await evaluation.onWithdrawalRequested(withdrawalEvent(holder.userId, holder.playerId, '500'));
    expect(await activeOf(holder.playerId, 'withdrawal_review')).toHaveLength(1);

    await setRule('withdrawal_review', { threshold: '100000' });
    await evaluation.onWithdrawalRequested(withdrawalEvent(holder.userId, holder.playerId, '1'));

    const history = await assignmentsOf(holder.playerId, 'withdrawal_review');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ removedAt: null, removalActor: null, removalReason: null });
    expect(auditOf(holder.playerId, 'tag.player.removed')).toEqual([]);
  });

  it('a player already holding the tag gets no duplicate assignment', async () => {
    await setRule('large_depositor', { threshold: '100' });
    const holder = await newPlayer();

    await evaluation.onDepositCompleted(depositEvent(holder.userId, holder.playerId, '250'));
    await evaluation.onDepositCompleted(depositEvent(holder.userId, holder.playerId, '300'));

    expect(await assignmentsOf(holder.playerId, 'large_depositor')).toHaveLength(1);
    expect(auditOf(holder.playerId, 'tag.player.assigned', 'large_depositor')).toHaveLength(1);
  });

  it.todo(
    'GAP: a manual removal blocks automatic re-assignment (tag-evaluation.service.ts:105 assigns again, nothing records a manual removal)',
  );

  it('evaluating an unknown player throws player not found', async () => {
    const unknownUserId = randomUUID();
    const before = auditTrail.length;

    await expect(
      evaluation.onKycUnderageDetected({
        userId: unknownUserId,
        playerId: null,
        referenceId: randomUUID(),
        tier: 'basic',
      }),
    ).rejects.toBeInstanceOf(PlayerNotFoundError);

    expect(auditTrail).toHaveLength(before);
    expect(
      await db().select().from(playerTag).where(eq(playerTag.assignActorUserId, unknownUserId)),
    ).toEqual([]);
  });

  it('a redelivered evaluation event is idempotent', async () => {
    await setRule('large_depositor', { threshold: '100' });
    const holder = await newPlayer();
    const delivery = depositEvent(holder.userId, holder.playerId, '400');

    await evaluation.onDepositCompleted(delivery);
    await expect(evaluation.onDepositCompleted(delivery)).resolves.toBeUndefined();
    await expect(evaluation.onDepositCompleted(delivery)).resolves.toBeUndefined();

    expect(await assignmentsOf(holder.playerId, 'large_depositor')).toHaveLength(1);
    expect(await activeOf(holder.playerId, 'large_depositor')).toHaveLength(1);
    expect(auditOf(holder.playerId, 'tag.player.assigned', 'large_depositor')).toHaveLength(1);
  });

  it('two concurrent evaluations of one player leave one active assignment', async () => {
    await setRule('large_depositor', { threshold: '100' });
    const holder = await newPlayer();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        evaluation.onDepositCompleted(depositEvent(holder.userId, holder.playerId, '250')),
      ),
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(8).fill('fulfilled'));
    expect(await assignmentsOf(holder.playerId, 'large_depositor')).toHaveLength(1);
    expect(await activeOf(holder.playerId, 'large_depositor')).toHaveLength(1);
    expect(auditOf(holder.playerId, 'tag.player.assigned', 'large_depositor')).toHaveLength(1);
  });

  it('a concurrent replace of a tag set commits for one caller and fails cleanly for the other', async () => {
    const holder = await newPlayer();
    await tags.assignPlayerTag({
      playerId: holder.playerId,
      tagKey: 'level',
      assignReason: 'player level set to 1',
      assignActor: 'scheduled',
      assignActorUserId: SYSTEM_ACTOR_ID,
    });
    const replace = (level: number) =>
      tags.replacePlayerTag({
        playerId: holder.playerId,
        tagKey: 'level',
        removalReason: 'player level changed',
        assignReason: `player level set to ${level}`,
        assignActor: 'scheduled',
        assignActorUserId: SYSTEM_ACTOR_ID,
      });

    const outcomes = await Promise.allSettled([replace(2), replace(3)]);

    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toBeInstanceOf(TagAlreadyInUseError);

    const history = await assignmentsOf(holder.playerId, 'level');
    expect(history).toHaveLength(2);
    const active = history.filter((row) => row.removedAt === null);
    expect(active).toHaveLength(1);
    expect(history.filter((row) => row.removedAt !== null)).toHaveLength(1);
    expect(auditOf(holder.playerId, 'tag.player.removed', 'level')).toHaveLength(1);
    expect(auditOf(holder.playerId, 'tag.player.assigned', 'level')).toHaveLength(2);
  });
});

describe('TagService.getActiveTagKeys', () => {
  async function tagIdFor(key: TagKey) {
    const [existing] = await db().select({ id: tag.id }).from(tag).where(eq(tag.key, key));
    if (existing) {
      return existing.id;
    }
    const [created] = await db().insert(tag).values({ key }).returning({ id: tag.id });
    if (!created) {
      throw new Error('tag insert returned no row');
    }
    return created.id;
  }

  it('reads on the caller transaction when given one, and nothing leaks after it rolls back', async () => {
    const userId = randomUUID();
    const rollback = new Error('rollback');
    const vip = await tagIdFor('vip');

    const seen = await db()
      .transaction(async (tx) => {
        const [row] = await tx.insert(player).values({ userId }).returning({ id: player.id });
        await tx.insert(playerTag).values({
          playerId: row?.id ?? '',
          tagId: vip,
          assignReason: 'seed',
          assignActor: 'manual',
          assignActorUserId: randomUUID(),
        });
        expect((await tags.getActiveTagKeys([userId], tx)).get(userId)).toEqual(['vip']);
        expect((await tags.getActiveTagKeys([userId])).has(userId)).toBe(false);
        throw rollback;
      })
      .catch((err: unknown) => err);

    expect(seen).toBe(rollback);
    expect((await tags.getActiveTagKeys([userId])).has(userId)).toBe(false);
  });

  it('groups active keys per user and leaves out removed assignments and untagged users', async () => {
    const tagged = await newPlayer();
    const untagged = await newPlayer();
    const [vip, risk] = [await tagIdFor('vip'), await tagIdFor('high_risk')];
    const assign = {
      assignReason: 'seed',
      assignActor: 'manual',
      assignActorUserId: randomUUID(),
    } as const;
    await db()
      .insert(playerTag)
      .values([
        { playerId: tagged.playerId, tagId: vip, ...assign },
        { playerId: tagged.playerId, tagId: risk, ...assign, removedAt: new Date() },
      ]);

    const map = await tags.getActiveTagKeys([tagged.userId, untagged.userId]);

    expect(map.get(tagged.userId)).toEqual(['vip']);
    expect(map.has(untagged.userId)).toBe(false);
  });
});

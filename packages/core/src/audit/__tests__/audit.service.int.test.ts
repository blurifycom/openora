import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { mapEventToRecord } from '../plugin.js';
import { auditLog } from '../schema/index.js';
import { AuditService, computeHash, startOfDayUtc, endOfDayUtc } from '../service/audit.service.js';
import { AuditListFiltersSchema } from '../contract/index.js';

describe('computeHash canonical form', () => {
  it('matches the frozen golden vector', () => {
    expect(
      computeHash({
        id: '11111111-1111-1111-1111-111111111111',
        actorId: null,
        actorType: 'system',
        action: 'test.action',
        resourceType: 'test',
        resourceId: null,
        before: null,
        after: null,
        result: null,
        seq: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        prevHash: null,
      }),
    ).toBe('4974d60531e6d9bd960f61a1d86371ac92aa12e31ec24ab3f61130aa6ee1f3ca');
  });

  it('changes when before/after/result differ - the mutation payload is in the chain', () => {
    const base = {
      id: '11111111-1111-1111-1111-111111111111',
      actorId: null,
      actorType: 'system' as const,
      action: 'test.action',
      resourceType: 'test',
      resourceId: null,
      seq: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      prevHash: null,
    };
    const unmodified = computeHash({ ...base, before: null, after: null, result: null });
    const tamperedAfter = computeHash({
      ...base,
      before: null,
      after: { role: 'admin' },
      result: null,
    });
    const tamperedResult = computeHash({ ...base, before: null, after: null, result: 'success' });

    expect(tamperedAfter).not.toBe(unmodified);
    expect(tamperedResult).not.toBe(unmodified);
  });

  it('is unaffected by nested before/after key order - jsonb round-tripping reorders keys', () => {
    const base = {
      id: '11111111-1111-1111-1111-111111111111',
      actorId: null,
      actorType: 'admin' as const,
      action: 'test.action',
      resourceType: 'test',
      resourceId: null,
      result: null,
      seq: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      prevHash: null,
    };

    const originalOrder = computeHash({
      ...base,
      before: { role: 'player', nested: { b: 2, a: 1 } },
      after: { nested: { b: 2, a: 1 }, role: 'admin' },
    });
    const reorderedKeys = computeHash({
      ...base,
      before: { nested: { a: 1, b: 2 }, role: 'player' },
      after: { role: 'admin', nested: { a: 1, b: 2 } },
    });

    expect(reorderedKeys).toBe(originalOrder);
  });
});

let db: TestDb;

function makeService() {
  return new AuditService(db.drizzle, makeEventBus());
}

async function seedPlayer(overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId: randomUUID(), displayName: 'Player', ...overrides })
    .returning();
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${auditLog}, ${player} RESTART IDENTITY CASCADE`);
});

describe('AuditService.record() (real PG)', () => {
  it('inserts with prevHash=null for the first row and stores a real sha256 hash', async () => {
    const result = await makeService().record({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });

    expect(result.prevHash).toBeNull();
    expect(result.hash).toBe(
      computeHash({
        id: result.id,
        actorId: result.actorId ?? null,
        actorType: result.actorType,
        action: result.action,
        resourceType: result.resourceType,
        resourceId: result.resourceId ?? null,
        before: result.before ?? null,
        after: result.after ?? null,
        result: result.result ?? null,
        seq: result.seq,
        createdAt: result.createdAt,
        prevHash: null,
      }),
    );
    expect(result.hash).not.toBe('pending');
  });

  it('chains prevHash from the latest existing row across sequential appends', async () => {
    const svc = makeService();
    const first = await svc.record({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });
    const second = await svc.record({
      actorType: 'system',
      action: 'wallet.deposit.completed',
      resourceType: 'wallet',
    });

    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.hash);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect((await svc.verifyChain()).valid).toBe(true);
  });

  it('records the row a social.friend_request.sent branch would produce', async () => {
    const friendshipId = randomUUID();
    const requesterId = randomUUID();
    const addresseeId = randomUUID();

    const result = await makeService().record({
      actorType: 'player',
      actorId: requesterId,
      action: 'social.friend_request.sent',
      resourceType: 'friendship',
      resourceId: friendshipId,
      after: { addresseeId, status: 'pending' },
      result: 'success',
    });

    expect(result).toMatchObject({
      actorType: 'player',
      actorId: requesterId,
      action: 'social.friend_request.sent',
      resourceType: 'friendship',
      resourceId: friendshipId,
      after: { addresseeId, status: 'pending' },
      result: 'success',
    });
  });

  it('records the row a social.friend_request.accepted branch would produce', async () => {
    const friendshipId = randomUUID();
    const accepterId = randomUUID();

    const result = await makeService().record({
      actorType: 'player',
      actorId: accepterId,
      action: 'social.friend_request.accepted',
      resourceType: 'friendship',
      resourceId: friendshipId,
      after: { status: 'accepted' },
      result: 'success',
    });

    expect(result).toMatchObject({
      actorType: 'player',
      actorId: accepterId,
      action: 'social.friend_request.accepted',
      resourceType: 'friendship',
      resourceId: friendshipId,
      after: { status: 'accepted' },
      result: 'success',
    });
  });
});

describe('AuditService.verifyChain() (real PG)', () => {
  async function seedRow(input: Parameters<AuditService['record']>[0]) {
    return makeService().record(input);
  }

  it('returns valid:true for an empty chain', async () => {
    expect(await makeService().verifyChain()).toEqual({ valid: true });
  });

  it('returns valid:true when hash chain is intact across two rows', async () => {
    await seedRow({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });
    await seedRow({
      actorType: 'system',
      action: 'wallet.deposit.completed',
      resourceType: 'wallet',
    });

    expect(await makeService().verifyChain()).toEqual({ valid: true });
  });

  it('detects a tampered row - wrong hash value', async () => {
    const row = await seedRow({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });
    await db.drizzle.db
      .update(auditLog)
      .set({ hash: 'tampered-wrong-hash' })
      .where(eq(auditLog.id, row.id));

    const result = await makeService().verifyChain();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rowId).toBe(row.id);
      expect(result.firstBrokenSeq).toBe(row.seq);
    }
  });

  it('detects a rewritten before/after/result - not just the id/action/actor fields', async () => {
    const row = await seedRow({
      actorId: 'admin-1',
      actorType: 'admin',
      action: 'admin.user.updated',
      resourceType: 'user',
      resourceId: 'user-9',
      before: { role: 'player' },
      after: { role: 'player' },
      result: 'success',
    });
    await db.drizzle.db
      .update(auditLog)
      .set({ after: { role: 'admin' } })
      .where(eq(auditLog.id, row.id));

    const result = await makeService().verifyChain();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rowId).toBe(row.id);
    }
  });

  it('detects a broken prevHash link between rows', async () => {
    await seedRow({
      actorType: 'system',
      action: 'identity.user.registered',
      resourceType: 'identity',
    });
    const second = await seedRow({
      actorType: 'system',
      action: 'wallet.deposit.completed',
      resourceType: 'wallet',
    });
    await db.drizzle.db
      .update(auditLog)
      .set({ prevHash: 'wrong-prev-hash' })
      .where(eq(auditLog.id, second.id));

    const result = await makeService().verifyChain();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rowId).toBe(second.id);
      expect(result.firstBrokenSeq).toBe(second.seq);
    }
  });
});

describe('AuditService.list() (real PG)', () => {
  async function seed(inputs: Parameters<AuditService['record']>[0][]) {
    const svc = makeService();
    for (const input of inputs) {
      await svc.record(input);
    }
  }

  it('returns paginated items with total', async () => {
    await seed([
      { actorType: 'system', action: 'a.one', resourceType: 'identity' },
      { actorType: 'system', action: 'a.two', resourceType: 'wallet' },
    ]);

    const result = await makeService().list({ page: 1, limit: 10 });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
  });

  it('applies actorId filter and returns empty result when no match', async () => {
    await seed([{ actorId: 'someone', actorType: 'admin', action: 'a', resourceType: 'x' }]);

    const result = await makeService().list({ actorId: 'user-xyz', page: 1, limit: 10 });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('q matches a row by actorId', async () => {
    await seed([
      { actorId: 'subject-1', actorType: 'player', action: 'a', resourceType: 'x' },
      { actorId: 'other', actorType: 'player', action: 'a', resourceType: 'x' },
    ]);

    const result = await makeService().list({ q: 'subject-1', page: 1, limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.actorId).toBe('subject-1');
    expect(result.total).toBe(1);
  });

  it('q matches a row by resourceId', async () => {
    await seed([
      { actorType: 'system', action: 'a', resourceType: 'transaction', resourceId: 'txn-9' },
    ]);

    const result = await makeService().list({ q: 'txn-9', page: 1, limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resourceId).toBe('txn-9');
    expect(result.total).toBe(1);
  });

  it('applies explicit resourceId filter', async () => {
    await seed([
      { actorType: 'system', action: 'a', resourceType: 'transaction', resourceId: 'txn-42' },
      { actorType: 'system', action: 'a', resourceType: 'transaction', resourceId: 'txn-99' },
    ]);

    const result = await makeService().list({ resourceId: 'txn-42', page: 1, limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resourceId).toBe('txn-42');
  });

  it('q combined with actorType still ANDs correctly', async () => {
    await seed([
      { actorId: 'subject-1', actorType: 'player', action: 'a', resourceType: 'x' },
      { actorId: 'subject-1', actorType: 'admin', action: 'a', resourceType: 'x' },
    ]);

    const result = await makeService().list({
      q: 'subject-1',
      actorType: 'player',
      page: 1,
      limit: 10,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.actorType).toBe('player');
  });

  it('respects page and limit for offset calculation', async () => {
    await seed(
      Array.from({ length: 12 }, (_, i) => ({
        actorType: 'system' as const,
        action: `a.${i}`,
        resourceType: 'x',
      })),
    );

    const result = await makeService().list({ page: 2, limit: 10 });

    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
    expect(result.total).toBe(12);
    expect(result.items).toHaveLength(2);
  });
});

describe('audit date-range boundaries', () => {
  it('endOfDayUtc spans the whole day so toDate includes same-day entries', () => {
    const end = endOfDayUtc('2026-07-21');
    expect(end.toISOString()).toBe('2026-07-21T23:59:59.999Z');

    const lateEntry = new Date('2026-07-21T22:00:00.000Z');
    expect(lateEntry <= end).toBe(true);
  });

  it('startOfDayUtc anchors to midnight UTC', () => {
    expect(startOfDayUtc('2026-07-21').toISOString()).toBe('2026-07-21T00:00:00.000Z');
  });

  it('list filters accept bare YYYY-MM-DD dates', () => {
    const parsed = AuditListFiltersSchema.safeParse({
      fromDate: '2026-07-01',
      toDate: '2026-07-21',
    });
    expect(parsed.success).toBe(true);
  });

  it('list filters reject a full timestamp so the day-boundary math cannot shift', () => {
    const parsed = AuditListFiltersSchema.safeParse({ toDate: '2026-07-21T22:00:00+05:00' });
    expect(parsed.success).toBe(false);
  });
});

describe('AuditService.exportCsv() (real PG)', () => {
  async function seed(inputs: Parameters<AuditService['record']>[0][]) {
    const svc = makeService();
    for (const input of inputs) {
      await svc.record(input);
    }
  }

  it('emits a header row followed by one data row per result', async () => {
    await seed([
      { actorId: 'u1', actorType: 'player', action: 'a.one', resourceType: 'identity' },
      { actorType: 'system', action: 'a.two', resourceType: 'wallet' },
    ]);

    const csv = await makeService().exportCsv({});
    const lines = csv.split('\n').filter(Boolean);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('hash');
  });

  it('includes correct field values in data rows', async () => {
    await seed([{ actorId: 'u1', actorType: 'player', action: 'a.one', resourceType: 'identity' }]);

    const csv = await makeService().exportCsv({});

    expect(csv).toContain('u1');
    expect(csv).toContain('player');
  });

  it('escapes double-quotes in field values', async () => {
    await seed([{ actorType: 'system', action: 'has "quotes"', resourceType: 'x' }]);

    const csv = await makeService().exportCsv({});

    expect(csv).toContain('has ""quotes""');
  });
});

describe('mapEventToRecord() player.id resolution', () => {
  // The emitter (never mapEventToRecord/AuditService) resolves playerId before the
  // event is published - these tests exercise the mapper as a pure function that
  // just reads p['playerId']/p['actorPlayerId'] straight off an already-resolved
  // payload, exactly as the real event bus delivers it.
  async function mapAndRecord(topic: string, payload: Record<string, unknown>) {
    const svc = makeService();
    const record = await mapEventToRecord(topic, payload);
    return svc.record(record);
  }

  it('compliance.kyc.updated: resourceId is the player.id, not the event userId', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('compliance.kyc.updated', {
      userId: p.userId,
      playerId: p.id,
      actorId: null,
      previousStatus: 'pending',
      status: 'verified',
    });

    expect(row.resourceId).toBe(p.id);
    expect(row.resourceId).not.toBe(p.userId);
    expect(row.resourceType).toBe('player');
  });

  it('compliance.kyc.updated: resourceId is null when the payload carries no playerId', async () => {
    const row = await mapAndRecord('compliance.kyc.updated', {
      userId: randomUUID(),
      playerId: null,
      actorId: null,
      previousStatus: 'pending',
      status: 'verified',
    });

    expect(row.resourceId).toBeNull();
  });

  it('compliance.kyc.submitted: actorId and resourceId both come from the resolved playerId (self-action)', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('compliance.kyc.submitted', {
      userId: p.userId,
      playerId: p.id,
      referenceId: 'ref-1',
      provider: 'sumsub',
    });

    expect(row.resourceId).toBe(p.id);
    expect(row.actorId).toBe(p.id);
  });

  it('compliance.kyc.reverify_required: resourceId comes from the payload playerId', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('compliance.kyc.reverify_required', {
      userId: p.userId,
      playerId: p.id,
      reason: 'address change',
    });

    expect(row.resourceId).toBe(p.id);
  });

  it('compliance.kyc.high_risk_signal_detected: resourceId comes from the payload playerId', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('compliance.kyc.high_risk_signal_detected', {
      userId: p.userId,
      playerId: p.id,
      referenceId: 'ref-2',
    });

    expect(row.resourceId).toBe(p.id);
  });

  it('chat.user.blocked: resourceId is the blocked player, actorId is the blocking player', async () => {
    const blocker = await seedPlayer();
    const blocked = await seedPlayer();

    const row = await mapAndRecord('chat.user.blocked', {
      blockerId: blocker.userId,
      actorPlayerId: blocker.id,
      blockedId: blocked.userId,
      playerId: blocked.id,
    });

    expect(row.resourceId).toBe(blocked.id);
    expect(row.actorId).toBe(blocker.id);
  });

  it('chat.user.ignored: resourceId is the ignored player, actorId is the ignoring player', async () => {
    const ignorer = await seedPlayer();
    const ignored = await seedPlayer();

    const row = await mapAndRecord('chat.user.ignored', {
      ignorerId: ignorer.userId,
      actorPlayerId: ignorer.id,
      ignoredId: ignored.userId,
      playerId: ignored.id,
    });

    expect(row.resourceId).toBe(ignored.id);
    expect(row.actorId).toBe(ignorer.id);
  });

  it('social.friendship.removed: resourceId is the friendshipId, actorId is the resolved playerId of whoever dissolved it', async () => {
    const actor = await seedPlayer();
    const other = await seedPlayer();
    const friendshipId = randomUUID();

    const row = await mapAndRecord('social.friendship.removed', {
      friendshipId,
      actorId: actor.userId,
      actorPlayerId: actor.id,
      otherUserId: other.userId,
      reason: 'removed_by_player',
    });

    expect(row.resourceType).toBe('friendship');
    expect(row.resourceId).toBe(friendshipId);
    expect(row.actorType).toBe('player');
    expect(row.actorId).toBe(actor.id);
    expect(row.after).toMatchObject({ status: 'removed', reason: 'removed_by_player' });
  });

  it('social.friendship.removed: carries reason "blocked" through to after', async () => {
    const actor = await seedPlayer();
    const other = await seedPlayer();
    const friendshipId = randomUUID();

    const row = await mapAndRecord('social.friendship.removed', {
      friendshipId,
      actorId: actor.userId,
      actorPlayerId: actor.id,
      otherUserId: other.userId,
      reason: 'blocked',
    });

    expect(row.after).toMatchObject({ status: 'removed', reason: 'blocked' });
  });

  it('social.friendship.removed: falls back to actorType admin and the raw actorId when the caller has no player row', async () => {
    const other = await seedPlayer();
    const friendshipId = randomUUID();
    const staffCallerId = randomUUID();

    const row = await mapAndRecord('social.friendship.removed', {
      friendshipId,
      actorId: staffCallerId,
      actorPlayerId: null,
      otherUserId: other.userId,
      reason: 'removed_by_player',
    });

    expect(row.actorType).toBe('admin');
    expect(row.actorId).toBe(staffCallerId);
  });

  it('player.level.changed: resourceId comes from the payload playerId', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('player.level.changed', {
      userId: p.userId,
      playerId: p.id,
      actorId: randomUUID(),
      previousLevel: 1,
      newLevel: 2,
    });

    expect(row.resourceId).toBe(p.id);
  });

  it('rg.limit.set / rg.self_exclusion.activated / rg.cooling_off.lifted: shared branch resolves resourceId from the payload playerId', async () => {
    const p = await seedPlayer();

    for (const topic of ['rg.limit.set', 'rg.self_exclusion.activated', 'rg.cooling_off.lifted']) {
      const row = await mapAndRecord(topic, {
        userId: p.userId,
        playerId: p.id,
        actorId: randomUUID(),
      });
      expect(row.resourceId).toBe(p.id);
    }
  });

  it('rg.exclusion.login_blocked: resourceId comes from the payload playerId', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('rg.exclusion.login_blocked', {
      userId: p.userId,
      playerId: p.id,
    });

    expect(row.resourceId).toBe(p.id);
  });

  it('rg.cooling_off.expired: system-attributed, resourceId comes from the payload playerId', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('rg.cooling_off.expired', {
      userId: p.userId,
      playerId: p.id,
      exclusionId: randomUUID(),
      expiresAt: new Date().toISOString(),
    });

    expect(row.resourceId).toBe(p.id);
    expect(row.actorType).toBe('system');
    expect(row.result).toBe('success');
  });

  it('player.login_blocked: resourceId comes from the payload playerId', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('player.login_blocked', { userId: p.userId, playerId: p.id });

    expect(row.resourceId).toBe(p.id);
  });

  it('tag.player.assigned is unaffected - resourceId still comes straight from playerId (already a player.id)', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('tag.player.assigned', {
      playerId: p.id,
      actorId: randomUUID(),
      tagKey: 'vip',
      reason: 'manual',
    });

    expect(row.resourceId).toBe(p.id);
  });

  it('wallet.withdrawal.requested: actorId comes from the resolved playerId, not the raw userId', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('wallet.withdrawal.requested', {
      userId: p.userId,
      playerId: p.id,
      transactionId: 'txn-1',
      amount: '10.00',
      currency: 'USD',
    });

    expect(row.actorId).toBe(p.id);
    expect(row.actorId).not.toBe(p.userId);
  });

  it('identity.user.login: no player row (admin account) - actorType is admin, actorId is the userId', async () => {
    const userId = randomUUID();

    const row = await mapAndRecord('identity.user.login', {
      userId,
      playerId: null,
    });

    expect(row.actorType).toBe('admin');
    expect(row.actorId).toBe(userId);
  });

  it('identity.user.login: resolved playerId (player account) - actorType is player, actorId is the player.id', async () => {
    const p = await seedPlayer();

    const row = await mapAndRecord('identity.user.login', {
      userId: p.userId,
      playerId: p.id,
    });

    expect(row.actorType).toBe('player');
    expect(row.actorId).toBe(p.id);
  });

  it('identity.user.registered: no player row yet - still actorType player, actorId null (unchanged carve-out)', async () => {
    const row = await mapAndRecord('identity.user.registered', {
      userId: randomUUID(),
      playerId: null,
    });

    expect(row.actorType).toBe('player');
    expect(row.actorId).toBeNull();
  });

  it('identity.profile.updated: no player row (admin account) - actorType is admin, actorId is the userId', async () => {
    const userId = randomUUID();

    const row = await mapAndRecord('identity.profile.updated', {
      userId,
      playerId: null,
    });

    expect(row.actorType).toBe('admin');
    expect(row.actorId).toBe(userId);
  });
});

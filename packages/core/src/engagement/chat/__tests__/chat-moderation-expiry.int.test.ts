import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  createTestDb,
  waitForAdvisoryLockWaiter,
  waitForRowLockWaiter,
  type TestDb,
} from '@openora/core/testing';
import type { AuditWritePort, RealtimeTransport } from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import { AuditService } from '@openora/core/audit/server';
import { makeEventBus, makeIdentityReader, mock, NO_CLIENT_META } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { chatMute, chatPlatformBan, chatPlayerCooldown } from '../schema/index.js';
import { ChatModerationExpiryService } from '../service/chat-moderation-expiry.service.js';
import { ChatModerationService } from '../service/chat-moderation.service.js';

let db: TestDb;
let audit: AuditWritePort;

const ADMIN_ID = randomUUID();

const secondsFromNow = (seconds: number) => new Date(Date.now() + seconds * 1000);

async function seedMute(overrides: Partial<typeof chatMute.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(chatMute)
    .values({
      userId: randomUUID(),
      roomId: null,
      scope: '__global',
      mutedBy: ADMIN_ID,
      reason: 'spam',
      ...overrides,
    })
    .returning();
  return row!;
}

async function seedBan(overrides: Partial<typeof chatPlatformBan.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(chatPlatformBan)
    .values({
      userId: randomUUID(),
      bannedBy: ADMIN_ID,
      roomId: null,
      scope: '__all_public',
      reason: 'abuse',
      ...overrides,
    })
    .returning();
  return row!;
}

async function seedCooldown(overrides: Partial<typeof chatPlayerCooldown.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(chatPlayerCooldown)
    .values({
      userId: randomUUID(),
      roomId: null,
      scope: '__all',
      cooldownSeconds: 30,
      createdBy: ADMIN_ID,
      reason: 'flooding',
      ...overrides,
    })
    .returning();
  return row!;
}

const auditRowsFor = (resourceId: string) =>
  db.drizzle.db.select().from(auditLog).where(eq(auditLog.resourceId, resourceId));

beforeAll(async () => {
  db = await createTestDb([migrate, migrateAudit]);
  // The real audit writer, so "exactly one audit entry" is a row count in audit_log
  // rather than a call count on a spy - the hash chain has to accept these writes too.
  const svc = new AuditService(db.drizzle, makeEventBus(), makeIdentityReader());
  audit = {
    record: (entry) => svc.record(entry).then(() => undefined),
    recordInTransaction: (tx, entry) => svc.recordInTransaction(tx, entry).then(() => undefined),
  };
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${chatMute}, ${chatPlatformBan}, ${chatPlayerCooldown}, ${auditLog} RESTART IDENTITY CASCADE`,
  );
});

describe('ChatModerationExpiryService.sweep', () => {
  const makeSweep = () => new ChatModerationExpiryService(db.drizzle, audit);
  const makeModeration = () =>
    new ChatModerationService(db.drizzle, mock<RealtimeTransport>({}), audit);

  it('records exactly one audit entry for a lapsed mute, dated from its own expiresAt', async () => {
    const expiresAt = secondsFromNow(-30);
    const mute = await seedMute({ expiresAt });

    expect(await makeSweep().sweep()).toEqual({ mutes: 1, bans: 0, cooldowns: 0 });

    const rows = await auditRowsFor(mute.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'chat.mute.expired',
      actorType: 'system',
      actorId: null,
      resourceType: 'chat_mute',
    });
    // The instant the player could post again, not the instant the cron noticed.
    expect((rows[0]!.before as Record<string, unknown>)['expiresAt']).toBe(expiresAt.toISOString());
    expect((rows[0]!.before as Record<string, unknown>)['userId']).toBe(mute.userId);
  });

  it('records exactly one audit entry for a lapsed platform ban', async () => {
    const expiresAt = secondsFromNow(-30);
    const ban = await seedBan({ expiresAt });

    expect(await makeSweep().sweep()).toEqual({ mutes: 0, bans: 1, cooldowns: 0 });

    const rows = await auditRowsFor(ban.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'chat.platform_ban.expired',
      actorType: 'system',
      actorId: null,
      resourceType: 'chat_platform_ban',
    });
    expect((rows[0]!.before as Record<string, unknown>)['expiresAt']).toBe(expiresAt.toISOString());
  });

  it('records exactly one audit entry for a lapsed cooldown', async () => {
    const expiresAt = secondsFromNow(-30);
    const cooldown = await seedCooldown({ expiresAt });
    await seedCooldown({ expiresAt: null });
    await seedCooldown({ expiresAt: secondsFromNow(3600) });

    expect(await makeSweep().sweep()).toEqual({ mutes: 0, bans: 0, cooldowns: 1 });
    expect(await makeSweep().sweep()).toEqual({ mutes: 0, bans: 0, cooldowns: 0 });

    const rows = await db.drizzle.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'chat.cooldown.expired',
      actorType: 'system',
      actorId: null,
      resourceType: 'chat_player_cooldown',
      resourceId: cooldown.id,
    });
    expect((rows[0]!.before as Record<string, unknown>)['expiresAt']).toBe(expiresAt.toISOString());
  });

  it('is idempotent - a second sweep records nothing more', async () => {
    const mute = await seedMute({ expiresAt: secondsFromNow(-30) });
    const ban = await seedBan({ expiresAt: secondsFromNow(-30) });

    await makeSweep().sweep();
    expect(await makeSweep().sweep()).toEqual({ mutes: 0, bans: 0, cooldowns: 0 });

    expect(await auditRowsFor(mute.id)).toHaveLength(1);
    expect(await auditRowsFor(ban.id)).toHaveLength(1);
  });

  it('leaves permanent, still-running and already-lifted entries alone', async () => {
    await seedMute({ expiresAt: null });
    await seedBan({ expiresAt: null });
    await seedMute({ expiresAt: secondsFromNow(3600) });
    await seedBan({ expiresAt: secondsFromNow(3600) });
    // A lapsed entry an admin had already lifted: its end is on the trail as
    // `chat.mute.lifted`, so a second entry would double-report the same ending.
    await seedMute({ expiresAt: secondsFromNow(-30), liftedAt: new Date(), liftedBy: ADMIN_ID });
    await seedBan({ expiresAt: secondsFromNow(-30), liftedAt: new Date(), liftedBy: ADMIN_ID });

    expect(await makeSweep().sweep()).toEqual({ mutes: 0, bans: 0, cooldowns: 0 });
    expect(await db.drizzle.db.select().from(auditLog)).toEqual([]);
  });

  it('writes one entry per lapse when two sweeps run concurrently over the same rows', async () => {
    const mute = await seedMute({ expiresAt: secondsFromNow(-30) });
    const ban = await seedBan({ expiresAt: secondsFromNow(-30) });

    const [a, b] = await Promise.all([makeSweep().sweep(), makeSweep().sweep()]);

    expect(a.mutes + b.mutes).toBe(1);
    expect(a.bans + b.bans).toBe(1);
    expect(await auditRowsFor(mute.id)).toHaveLength(1);
    expect(await auditRowsFor(ban.id)).toHaveLength(1);
  });

  it('records no expiry for a lift that commits while the sweep waits on the row', async () => {
    const mute = await seedMute({ expiresAt: secondsFromNow(-30) });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let markLifted!: () => void;
    const liftWritten = new Promise<void>((resolve) => (markLifted = resolve));
    const lift = db.drizzle.db.transaction(async (tx) => {
      await tx
        .update(chatMute)
        .set({ liftedAt: secondsFromNow(-60), liftedBy: ADMIN_ID })
        .where(eq(chatMute.id, mute.id));
      markLifted();
      await released;
    });
    await liftWritten;

    const sweep = makeSweep().sweep();
    await waitForRowLockWaiter(db);
    release();
    await lift;

    expect(await sweep).toEqual({ mutes: 0, bans: 0, cooldowns: 0 });
    expect(await auditRowsFor(mute.id)).toEqual([]);
  });

  it('stamps expiryRecordedAt so the row stops matching the scan', async () => {
    const mute = await seedMute({ expiresAt: secondsFromNow(-30) });

    await makeSweep().sweep();

    const [row] = await db.drizzle.db.select().from(chatMute).where(eq(chatMute.id, mute.id));
    expect(row!.expiryRecordedAt).toBeInstanceOf(Date);
    // The bookmark is not an enforcement input: the mute is still lapsed, still unlifted.
    expect(row!.liftedAt).toBeNull();
  });

  // A lapsed row is not active, so lifting it is a no-op in both directions: the trail
  // carries `expired` or `lifted` for a given row, never both.
  it('leaves an admin lift after the sweep off the trail', async () => {
    const userId = randomUUID();
    const mute = await seedMute({ userId, expiresAt: secondsFromNow(-30) });
    const ban = await seedBan({ userId, expiresAt: secondsFromNow(-30) });

    await makeSweep().sweep();

    const moderation = makeModeration();
    await moderation.unmute({ userId, roomId: '__global', actorId: ADMIN_ID, ...NO_CLIENT_META });
    await moderation.unban({
      userId,
      roomId: '__all_public',
      actorId: ADMIN_ID,
      ...NO_CLIENT_META,
    });

    expect((await auditRowsFor(mute.id)).map((r) => r.action)).toEqual(['chat.mute.expired']);
    expect((await auditRowsFor(ban.id)).map((r) => r.action)).toEqual([
      'chat.platform_ban.expired',
    ]);
    const [muteRow] = await db.drizzle.db.select().from(chatMute).where(eq(chatMute.id, mute.id));
    expect(muteRow!.liftedAt).toBeNull();
  });

  it('leaves a lapsed mute to the sweep when the player is muted again', async () => {
    const userId = randomUUID();
    const expiresAt = secondsFromNow(-30);
    const lapsed = await seedMute({ userId, expiresAt });

    await makeModeration().mute({
      userId,
      roomId: '__global',
      durationSeconds: 60,
      reason: 'again',
      actorId: ADMIN_ID,
      ...NO_CLIENT_META,
    });
    await makeSweep().sweep();

    const [row] = await db.drizzle.db.select().from(chatMute).where(eq(chatMute.id, lapsed.id));
    expect(row).toMatchObject({ liftedAt: expiresAt, liftedBy: null });
    expect((await auditRowsFor(lapsed.id)).map((r) => r.action)).toEqual(['chat.mute.expired']);
    const [created] = await db.drizzle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'chat.mute.created'));
    expect(created!.before).toBeNull();
  });

  it('leaves a lapsed ban to the sweep when the player is banned again', async () => {
    const userId = randomUUID();
    const expiresAt = secondsFromNow(-30);
    const lapsed = await seedBan({ userId, expiresAt });

    await makeModeration().ban({
      userId,
      roomId: '__all_public',
      durationSeconds: 60,
      reason: 'again',
      actorId: ADMIN_ID,
      ...NO_CLIENT_META,
    });
    await makeSweep().sweep();

    const [row] = await db.drizzle.db
      .select()
      .from(chatPlatformBan)
      .where(eq(chatPlatformBan.id, lapsed.id));
    expect(row).toMatchObject({ liftedAt: expiresAt, liftedBy: null });
    expect((await auditRowsFor(lapsed.id)).map((r) => r.action)).toEqual([
      'chat.platform_ban.expired',
    ]);
  });

  it('records the replaced terms when a running mute is replaced', async () => {
    const userId = randomUUID();
    const running = await seedMute({ userId, expiresAt: secondsFromNow(3600) });

    await makeModeration().mute({
      userId,
      roomId: '__global',
      durationSeconds: null,
      reason: 'escalated',
      actorId: ADMIN_ID,
      ...NO_CLIENT_META,
    });

    const [created] = await db.drizzle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'chat.mute.created'));
    expect(created!.before).toMatchObject({ muteId: running.id, reason: 'spam' });
    expect(await auditRowsFor(running.id)).toHaveLength(0);
  });

  it('lifts the replacement when an unmute arrives during a re-mute', async () => {
    const userId = randomUUID();
    const running = await seedMute({ userId, expiresAt: secondsFromNow(3600) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let replaced!: () => void;
    const midway = new Promise<void>((resolve) => (replaced = resolve));

    const remute = db.drizzle.db.transaction(async (t) => {
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`chat-mute:${userId}`}))`);
      await t
        .update(chatMute)
        .set({ liftedAt: new Date(), liftedBy: ADMIN_ID })
        .where(eq(chatMute.id, running.id));
      await t
        .insert(chatMute)
        .values({ userId, roomId: null, scope: '__global', mutedBy: ADMIN_ID, reason: 'again' });
      replaced();
      await held;
    });
    await midway;
    const unmute = makeModeration().unmute({
      userId,
      roomId: '__global',
      actorId: ADMIN_ID,
      ...NO_CLIENT_META,
    });
    await waitForAdvisoryLockWaiter(db);
    release();
    await remute;
    await unmute;

    const active = await db.drizzle.db
      .select()
      .from(chatMute)
      .where(sql`${chatMute.userId} = ${userId} AND ${chatMute.liftedAt} IS NULL`);
    expect(active).toHaveLength(0);
    expect(
      await db.drizzle.db.select().from(auditLog).where(eq(auditLog.action, 'chat.mute.lifted')),
    ).toHaveLength(1);
  });
});

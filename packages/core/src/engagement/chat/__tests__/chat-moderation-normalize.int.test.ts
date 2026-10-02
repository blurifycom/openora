import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { chatMessage, chatMute, chatPlatformBan, chatRoom } from '../schema/index.js';

const readMigration = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../drizzle/migrations/${name}.sql`, import.meta.url)),
    'utf8',
  ).split('--> statement-breakpoint');

let db: TestDb;
let globalRoomId: string;
let publicRoomId: string;

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

async function runMigration(name: string) {
  for (const statement of readMigration(name)) {
    await db.drizzle.db.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  // Back to the pre-0016 shape, so rows the old code could write can be seeded.
  await db.drizzle.db.execute(sql`DROP INDEX "chat_mute_active_scope_key"`);
  await db.drizzle.db.execute(sql`DROP INDEX "chat_mute_active_room_key"`);
  const [globalRoom] = await db.drizzle.db
    .select({ id: chatRoom.id })
    .from(chatRoom)
    .where(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID));
  globalRoomId = globalRoom!.id;
  const [publicRoom] = await db.drizzle.db
    .insert(chatRoom)
    .values({ name: 'Lobby', slug: `lobby-${randomUUID()}` })
    .returning({ id: chatRoom.id });
  publicRoomId = publicRoom!.id;
});

afterAll(async () => {
  await db.drop();
});

describe('migration 0015 normalize chat moderation rows', () => {
  it('folds global-room rows onto __global and lets 0016 build its indexes', async () => {
    const adminId = randomUUID();
    const banned = randomUUID();
    const muted = randomUUID();
    const legacy = randomUUID();
    const sender = randomUUID();
    const [shortBan] = await db.drizzle.db
      .insert(chatPlatformBan)
      .values({
        userId: banned,
        bannedBy: adminId,
        scope: '__global',
        reason: 'short',
        expiresAt: hoursFromNow(1),
      })
      .returning();
    const [permanentBan] = await db.drizzle.db
      .insert(chatPlatformBan)
      .values({
        userId: banned,
        bannedBy: adminId,
        scope: 'room',
        roomId: globalRoomId,
        reason: 'permanent',
      })
      .returning();
    const lapsedAt = hoursFromNow(-1);
    const [lapsedMute] = await db.drizzle.db
      .insert(chatMute)
      .values({ userId: muted, mutedBy: adminId, reason: 'old', expiresAt: lapsedAt })
      .returning();
    const [runningMute] = await db.drizzle.db
      .insert(chatMute)
      .values({ userId: muted, mutedBy: adminId, reason: 'new', expiresAt: hoursFromNow(1) })
      .returning();
    const [legacyMute] = await db.drizzle.db
      .insert(chatMute)
      .values({ userId: legacy, mutedBy: adminId, roomId: publicRoomId, reason: 'legacy' })
      .returning();
    const [message] = await db.drizzle.db
      .insert(chatMessage)
      .values({ roomId: globalRoomId, userId: sender, username: 'sender', content: 'hi' })
      .returning();

    const globalMuted = randomUUID();
    const [globalMute] = await db.drizzle.db
      .insert(chatMute)
      .values({
        userId: globalMuted,
        mutedBy: adminId,
        reason: 'global',
        expiresAt: hoursFromNow(1),
      })
      .returning();
    const [roomIdMute] = await db.drizzle.db
      .insert(chatMute)
      .values({
        userId: globalMuted,
        mutedBy: adminId,
        scope: 'room',
        roomId: globalRoomId,
        reason: 'by row id',
      })
      .returning();
    const lapsedBanned = randomUUID();
    const lapsedBanAt = hoursFromNow(-2);
    const [olderLapsedBan] = await db.drizzle.db
      .insert(chatPlatformBan)
      .values({
        userId: lapsedBanned,
        bannedBy: adminId,
        scope: '__global',
        reason: 'older',
        expiresAt: lapsedBanAt,
      })
      .returning();
    const [newerLapsedBan] = await db.drizzle.db
      .insert(chatPlatformBan)
      .values({
        userId: lapsedBanned,
        bannedBy: adminId,
        scope: 'room',
        roomId: globalRoomId,
        reason: 'newer',
        expiresAt: hoursFromNow(-1),
      })
      .returning();

    await runMigration('0015_normalize_chat_moderation_rows');
    await runMigration('0016_chat_mute_active_unique');

    const bans = await db.drizzle.db
      .select()
      .from(chatPlatformBan)
      .where(eq(chatPlatformBan.userId, banned));
    expect(bans.find((ban) => ban.id === permanentBan!.id)).toMatchObject({
      scope: '__global',
      roomId: null,
      liftedAt: null,
    });
    expect(bans.find((ban) => ban.id === shortBan!.id)?.liftedAt).toBeInstanceOf(Date);

    const mutes = await db.drizzle.db.select().from(chatMute).where(eq(chatMute.userId, muted));
    expect(mutes.find((mute) => mute.id === runningMute!.id)?.liftedAt).toBeNull();
    // Lifted at its own expiry with no actor, so the expiry sweep still records it.
    expect(mutes.find((mute) => mute.id === lapsedMute!.id)).toMatchObject({
      liftedAt: lapsedAt,
      liftedBy: null,
    });

    const [converted] = await db.drizzle.db
      .select()
      .from(chatMute)
      .where(eq(chatMute.id, legacyMute!.id));
    expect(converted).toMatchObject({ scope: '__global', roomId: null, liftedAt: null });

    const globalMutes = await db.drizzle.db
      .select()
      .from(chatMute)
      .where(eq(chatMute.userId, globalMuted));
    // The row-id mute is permanent, so it wins and becomes the player's `__global` mute.
    expect(globalMutes.find((mute) => mute.id === roomIdMute!.id)).toMatchObject({
      scope: '__global',
      roomId: null,
      liftedAt: null,
    });
    expect(globalMutes.find((mute) => mute.id === globalMute!.id)?.liftedAt).toBeInstanceOf(Date);

    const lapsedBans = await db.drizzle.db
      .select()
      .from(chatPlatformBan)
      .where(eq(chatPlatformBan.userId, lapsedBanned));
    expect(lapsedBans.find((ban) => ban.id === olderLapsedBan!.id)).toMatchObject({
      liftedAt: lapsedBanAt,
      liftedBy: null,
    });
    expect(lapsedBans.find((ban) => ban.id === newerLapsedBan!.id)).toMatchObject({
      scope: '__global',
      roomId: null,
      liftedAt: null,
    });

    const [moved] = await db.drizzle.db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.id, message!.id));
    expect(moved!.roomId).toBeNull();
  });
});

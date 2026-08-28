import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, InProcessRealtimeTransport, type TestDb } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import type { AdminUserDirectory, AuditWritePort } from '@openora/core/contracts';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { NO_CLIENT_META, makeEventBus, makeIdentityReader, mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { chatRoom } from '../schema/index.js';
import { ChatService, ChatRoomProtectedError } from '../service/chat.service.js';
import { ChatModerationService } from '../service/chat-moderation.service.js';

const SEED_GLOBAL_CHAT_ROOM_SQL = readFileSync(
  fileURLToPath(new URL('../drizzle/migrations/0007_seed_global_chat_room.sql', import.meta.url)),
  'utf8',
);

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, migrateIdentity, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

function makeService() {
  const transport = new InProcessRealtimeTransport();
  const events = makeEventBus();
  const audit = mock<AuditWritePort>({
    record: vi.fn().mockResolvedValue(undefined),
    recordInTransaction: vi.fn().mockResolvedValue(undefined),
  });
  const moderation = new ChatModerationService(db.drizzle, transport, audit);
  const directory = mock<AdminUserDirectory>({ lookupPlayers: async () => [] });
  return new ChatService(
    db.drizzle,
    events,
    transport,
    directory,
    audit,
    moderation,
    makeIdentityReader(),
    [],
  );
}

describe('global chat room invariant', () => {
  it('is provisioned by the chat module migration', async () => {
    const [room] = await db.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID));

    expect(room).toBeDefined();
    expect(room?.isPublic).toBe(true);
    expect(room?.deletedAt).toBeNull();
  });

  it('is returned by listRooms so getConnection can grant chat:global', async () => {
    const svc = makeService();
    const rooms = await svc.listRooms();

    expect(rooms.some((room) => room.slug === GLOBAL_CHAT_ROOM_ID)).toBe(true);
  });

  it('cannot be deleted through the admin deleteRoom path', async () => {
    const svc = makeService();
    const [globalRoom] = await db.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID));

    await expect(svc.deleteRoom(globalRoom!.id, undefined, NO_CLIENT_META)).rejects.toThrow(
      ChatRoomProtectedError,
    );

    const [stillThere] = await db.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID));
    expect(stillThere?.deletedAt).toBeNull();
  });

  it('cannot have its slug changed through the admin updateRoom path', async () => {
    const svc = makeService();
    const [globalRoom] = await db.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID));

    await expect(
      svc.updateRoom({ id: globalRoom!.id, slug: 'renamed', ...NO_CLIENT_META }),
    ).rejects.toThrow(ChatRoomProtectedError);

    const [stillThere] = await db.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID));
    expect(stillThere).toBeDefined();
  });

  it('is restored by re-applying the seed statement if it was previously soft-deleted out-of-band', async () => {
    await db.drizzle.db
      .update(chatRoom)
      .set({ deletedAt: new Date(), isPublic: false })
      .where(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID));

    // Migrations only re-run once per tracked db (migrate() would be a no-op here), so this
    // re-executes the migration's own statement to prove its ON CONFLICT clause restores the
    // room rather than leaving a soft-deleted row in place forever.
    await db.drizzle.db.execute(sql.raw(SEED_GLOBAL_CHAT_ROOM_SQL));

    const [room] = await db.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID));
    expect(room?.deletedAt).toBeNull();
    expect(room?.isPublic).toBe(true);
  });
});

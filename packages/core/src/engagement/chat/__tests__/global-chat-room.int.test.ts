import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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
  );
}

describe('global chat room invariant (BF-466)', () => {
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
});

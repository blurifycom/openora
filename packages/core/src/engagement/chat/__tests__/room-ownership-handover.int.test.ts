import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDb, InProcessRealtimeTransport, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import type {
  AdminUserDirectory,
  AuditWritePort,
  RealtimeTransport,
} from '@openora/core/contracts';
import { NO_CLIENT_META, makeEventBus, makeIdentityReader, mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  CHAT_MEMBER_ROLE_CHANGED_SIGNAL,
  CHAT_ROOM_SCHEDULED_FOR_DELETION_SIGNAL,
  OWNERLESS_ROOM_RETENTION_DAYS,
} from '../contract/constants.js';
import {
  chatMessage,
  chatMute,
  chatPlatformBan,
  chatRoom,
  chatRoomBan,
  chatRoomConfiguration,
  chatRoomMember,
  chatRoomMute,
  chatRoomRemove,
  chatRoomRule,
  chatUserBlock,
  chatUserIgnore,
} from '../schema/index.js';
import { ChatService } from '../service/chat.service.js';
import { ChatModerationService } from '../service/chat-moderation.service.js';
import { ChatRoomMembershipService } from '../service/chat-room-membership.service.js';
import { ChatRoomPurgeService } from '../service/chat-room-purge.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let db: TestDb;

function makeServices(transport: RealtimeTransport = new InProcessRealtimeTransport()) {
  const events = makeEventBus();
  const audit = mock<AuditWritePort>({
    record: vi.fn().mockResolvedValue(undefined),
    recordInTransaction: vi.fn().mockResolvedValue(undefined),
  });
  const directory = mock<AdminUserDirectory>({
    lookupPlayers: async () => [],
    lookupUsers: async (ids: readonly string[]) =>
      ids.map((id) => ({
        id,
        email: `${id}@example.com`,
        name: id,
        createdAt: new Date(),
        isActive: true,
        role: 'player',
      })),
  });
  const identityReader = makeIdentityReader();
  const moderation = new ChatModerationService(db.drizzle, transport, audit);
  const chat = new ChatService({
    drizzle: db.drizzle,
    events,
    transport,
    directory,
    audit,
    moderation,
    identityReader,
    allowedAttachmentHosts: [],
  });
  const membership = new ChatRoomMembershipService(
    db.drizzle,
    events,
    audit,
    transport,
    identityReader,
  );
  const purge = new ChatRoomPurgeService(db.drizzle, events, transport);
  return { chat, membership, purge, events, transport };
}

/** A private room owned by `ownerId`, with the given ids joined as plain members. */
async function seedPrivateRoom(
  services: ReturnType<typeof makeServices>,
  ownerId: string,
  memberIds: string[] = [],
) {
  const room = await services.chat.createPrivateRoom({
    userId: ownerId,
    name: 'Wheel Spin',
    ...NO_CLIENT_META,
  });
  for (const userId of memberIds) {
    await services.membership.joinRoom({ userId, joinCode: room.joinCode!, ...NO_CLIENT_META });
  }
  return room;
}

/** Promote through the real route, then pin `roleAssignedAt` so successor order is exact. */
async function promote(
  services: ReturnType<typeof makeServices>,
  room: { id: string },
  ownerId: string,
  userId: string,
  roleAssignedAt?: Date | null,
) {
  await services.membership.setMemberRole({
    actorId: ownerId,
    roomId: room.id,
    userId,
    role: 'moderator',
    ...NO_CLIENT_META,
  });
  if (roleAssignedAt !== undefined) {
    await db.drizzle.db
      .update(chatRoomMember)
      .set({ roleAssignedAt })
      .where(and(eq(chatRoomMember.roomId, room.id), eq(chatRoomMember.userId, userId)));
  }
}

function readMember(roomId: string, userId: string) {
  return db.drizzle.db
    .select()
    .from(chatRoomMember)
    .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
    .limit(1)
    .then(([row]) => row!);
}

/** The `memberIds` the countdown event actually carried - ie who gets notified. */
function emittedAudience(services: ReturnType<typeof makeServices>): string[] {
  const call = services.events.emit.mock.calls.find(
    (args: unknown[]) => args[0] === 'chat.room.scheduled_for_deletion',
  );
  return (call?.[1] as { memberIds: string[] } | undefined)?.memberIds ?? [];
}

function readRoom(roomId: string) {
  return db.drizzle.db
    .select()
    .from(chatRoom)
    .where(eq(chatRoom.id, roomId))
    .limit(1)
    .then(([row]) => row ?? null);
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateIdentity, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${chatMessage}, ${chatRoomRule}, ${chatRoomConfiguration}, ${chatRoomMember}, ${chatRoomBan}, ${chatRoomMute}, ${chatRoomRemove}, ${chatMute}, ${chatPlatformBan}, ${chatUserBlock}, ${chatUserIgnore}, ${chatRoom}, ${user} RESTART IDENTITY CASCADE`,
  );
});

describe('ChatRoomMembershipService.handleAccountClosed - transfer (real PG)', () => {
  it('hands the room to the only moderator, moving both halves of ownership', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const modId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [modId]);
    await promote(services, room, ownerId, modId);
    const closedAt = new Date('2026-08-31T10:00:00.000Z');

    await services.membership.handleAccountClosed({ userId: ownerId, closedAt });

    // `creatorId` gates room edit/delete and `role` gates the moderation guards - a
    // transfer that moved only one leaves a room its new owner cannot administer.
    const stored = await readRoom(room.id);
    expect(stored?.creatorId).toBe(modId);
    expect(stored?.scheduledDeletionAt).toBeNull();
    const successor = await readMember(room.id, modId);
    expect(successor.role).toBe('owner');
    expect(successor.roleAssignedAt).toBeInstanceOf(Date);
    const previous = await readMember(room.id, ownerId);
    expect(previous).toMatchObject({ role: 'member', roleAssignedAt: null });
    expect(previous.accountClosedAt?.toISOString()).toBe(closedAt.toISOString());
    expect(services.events.emit).toHaveBeenCalledWith('chat.room.ownership.transferred', {
      roomId: room.id,
      roomName: 'Wheel Spin',
      previousOwnerId: ownerId,
      newOwnerId: modId,
      reason: 'account-closed',
    });
  });

  it('picks the moderator with the earliest assignment, skipping one already closed', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const [deadMod, earlyMod, lateMod] = [randomUUID(), randomUUID(), randomUUID()];
    const room = await seedPrivateRoom(services, ownerId, [deadMod, earlyMod, lateMod]);
    // The earliest stamp of the three belongs to an account that is already closed: a dead
    // account must never inherit the room, so the next-earliest live one wins.
    await promote(services, room, ownerId, deadMod, new Date('2026-01-01T00:00:00.000Z'));
    await promote(services, room, ownerId, earlyMod, new Date('2026-02-01T00:00:00.000Z'));
    await promote(services, room, ownerId, lateMod, new Date('2026-03-01T00:00:00.000Z'));
    await services.membership.handleAccountClosed({
      userId: deadMod,
      closedAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    await services.membership.handleAccountClosed({
      userId: ownerId,
      closedAt: new Date('2026-08-31T10:00:00.000Z'),
    });

    expect((await readRoom(room.id))?.creatorId).toBe(earlyMod);
    expect((await readMember(room.id, earlyMod)).role).toBe('owner');
    expect((await readMember(room.id, lateMod)).role).toBe('moderator');
    // The closed moderator keeps its row and its role - only the stamp rules it out as a
    // successor. Demotion belongs to the closed *owner*, whose ownership had to move.
    expect(await readMember(room.id, deadMod)).toMatchObject({ role: 'moderator' });
    expect((await readMember(room.id, deadMod)).accountClosedAt).toBeInstanceOf(Date);
  });

  it('falls back to joinedAt for moderators a backfill left without an assignment stamp', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [first, second]);
    await promote(services, room, ownerId, first, null);
    await promote(services, room, ownerId, second, null);
    await db.drizzle.db
      .update(chatRoomMember)
      .set({ joinedAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(and(eq(chatRoomMember.roomId, room.id), eq(chatRoomMember.userId, second)));

    await services.membership.handleAccountClosed({ userId: ownerId, closedAt: new Date() });

    expect((await readRoom(room.id))?.creatorId).toBe(second);
  });

  it('signals both the successor and the demoted owner so rosters refetch', async () => {
    const signal = vi.fn();
    const services = makeServices(Object.assign(new InProcessRealtimeTransport(), { signal }));
    const ownerId = randomUUID();
    const modId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [modId]);
    await promote(services, room, ownerId, modId);
    signal.mockClear();

    await services.membership.handleAccountClosed({ userId: ownerId, closedAt: new Date() });

    expect(signal).toHaveBeenCalledWith(`chat:room:${room.id}`, CHAT_MEMBER_ROLE_CHANGED_SIGNAL, {
      roomId: room.id,
      userId: modId,
      role: 'owner',
    });
    expect(signal).toHaveBeenCalledWith(`chat:room:${room.id}`, CHAT_MEMBER_ROLE_CHANGED_SIGNAL, {
      roomId: room.id,
      userId: ownerId,
      role: 'member',
    });
  });
});

describe('ChatRoomMembershipService.handleAccountClosed - countdown (real PG)', () => {
  it('starts a 30-day countdown and freezes administration when nobody can inherit', async () => {
    const signal = vi.fn();
    const services = makeServices(Object.assign(new InProcessRealtimeTransport(), { signal }));
    const ownerId = randomUUID();
    const memberIds = [randomUUID(), randomUUID()];
    const room = await seedPrivateRoom(services, ownerId, memberIds);
    const closedAt = new Date('2026-08-31T10:00:00.000Z');

    await services.membership.handleAccountClosed({ userId: ownerId, closedAt });

    const stored = await readRoom(room.id);
    expect(stored?.creatorId).toBeNull();
    expect(stored?.scheduledDeletionAt?.toISOString()).toBe(
      new Date(closedAt.getTime() + OWNERLESS_ROOM_RETENTION_DAYS * DAY_MS).toISOString(),
    );
    // The notification audience: the live members only. The closed owner is named
    // separately rather than carried in it.
    expect(services.events.emit).toHaveBeenCalledWith(
      'chat.room.scheduled_for_deletion',
      expect.objectContaining({
        roomId: room.id,
        roomName: 'Wheel Spin',
        previousOwnerId: ownerId,
        memberIds: expect.arrayContaining(memberIds),
        scheduledDeletionAt: stored!.scheduledDeletionAt!.toISOString(),
      }),
    );
    expect(emittedAudience(services)).not.toContain(ownerId);
    expect(signal).toHaveBeenCalledWith(
      `chat:room:${room.id}`,
      CHAT_ROOM_SCHEDULED_FOR_DELETION_SIGNAL,
      { roomId: room.id, scheduledDeletionAt: stored!.scheduledDeletionAt!.toISOString() },
    );
  });

  it('leaves a member whose own account is already closed out of the audience', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const activeId = randomUUID();
    const closedId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [activeId, closedId]);
    // A player closed before the owner was: their row stays on the roster, but they have
    // no session and can never open the room again, so a notification for them is
    // unreadable by anyone.
    await services.membership.handleAccountClosed({
      userId: closedId,
      closedAt: new Date('2026-08-30T10:00:00.000Z'),
    });
    services.events.emit.mockClear();

    await services.membership.handleAccountClosed({
      userId: ownerId,
      closedAt: new Date('2026-08-31T10:00:00.000Z'),
    });

    // Exactly one recipient - the fan-out creates one notification per id, so this is the
    // one notification the room produces.
    expect(emittedAudience(services)).toEqual([activeId]);
    // The roster itself is untouched: both closed rows are still there, flagged.
    const roster = await services.chat.listRoomMembers({ roomId: room.id, viewerId: activeId });
    expect(roster).toHaveLength(3);
    expect(
      roster
        .filter((m) => m.isDeletedAccount)
        .map((m) => m.userId)
        .sort(),
    ).toEqual([ownerId, closedId].sort());
  });

  it('leaves the room readable and writable for its members throughout the window (AC4)', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [memberId]);
    await services.membership.handleAccountClosed({ userId: ownerId, closedAt: new Date() });

    await services.chat.sendRoomMessage({
      userId: memberId,
      username: 'bob',
      roomId: room.id,
      content: 'still here',
    });

    const messages = await services.chat.getRoomMessages({ roomId: room.id, viewerId: memberId });
    expect(messages.map((m) => m.content)).toContain('still here');
  });

  it('never moves the deadline once it is running, whatever members do (AC6)', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [memberId]);
    const closedAt = new Date('2026-08-31T10:00:00.000Z');
    await services.membership.handleAccountClosed({ userId: ownerId, closedAt });
    const deadline = (await readRoom(room.id))!.scheduledDeletionAt;

    await services.chat.sendRoomMessage({
      userId: memberId,
      username: 'bob',
      roomId: room.id,
      content: 'hello',
    });
    const latecomer = randomUUID();
    await services.membership.joinRoom({
      userId: latecomer,
      joinCode: room.joinCode!,
      ...NO_CLIENT_META,
    });
    await services.membership.handleAccountClosed({
      userId: ownerId,
      closedAt: new Date('2026-09-15T10:00:00.000Z'),
    });

    expect((await readRoom(room.id))!.scheduledDeletionAt?.toISOString()).toBe(
      deadline?.toISOString(),
    );
  });

  it('is a no-op the second time it runs for the same account', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const modId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [modId]);
    await promote(services, room, ownerId, modId);
    await services.membership.handleAccountClosed({
      userId: ownerId,
      closedAt: new Date('2026-08-31T10:00:00.000Z'),
    });
    const afterFirst = await readRoom(room.id);
    const successorAfterFirst = await readMember(room.id, modId);
    services.events.emit.mockClear();

    // The second trigger for one person - an admin close plus a deactivation.
    await services.membership.handleAccountClosed({
      userId: ownerId,
      closedAt: new Date('2026-09-01T10:00:00.000Z'),
    });

    expect(await readRoom(room.id)).toEqual(afterFirst);
    expect(await readMember(room.id, modId)).toEqual(successorAfterFirst);
    expect(services.events.emit).not.toHaveBeenCalled();
  });
});

describe('ChatRoomMembershipService.handleAccountClosed - non-owners (real PG)', () => {
  it('marks a closed moderator without transferring or starting a countdown', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const modId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [modId]);
    await promote(services, room, ownerId, modId);

    await services.membership.handleAccountClosed({ userId: modId, closedAt: new Date() });

    const stored = await readRoom(room.id);
    expect(stored?.creatorId).toBe(ownerId);
    expect(stored?.scheduledDeletionAt).toBeNull();
    expect((await readMember(room.id, modId)).accountClosedAt).toBeInstanceOf(Date);
    expect((await readMember(room.id, ownerId)).role).toBe('owner');
  });

  it('marks a closed plain member and changes nothing else', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [memberId]);

    await services.membership.handleAccountClosed({ userId: memberId, closedAt: new Date() });

    const stored = await readRoom(room.id);
    expect(stored?.creatorId).toBe(ownerId);
    expect(stored?.scheduledDeletionAt).toBeNull();
    expect((await readMember(room.id, memberId)).accountClosedAt).toBeInstanceOf(Date);
    expect(services.events.emit).not.toHaveBeenCalledWith(
      'chat.room.scheduled_for_deletion',
      expect.anything(),
    );
  });

  it('leaves public rooms alone - they have no owner to inherit', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const [publicRoom] = await db.drizzle.db
      .insert(chatRoom)
      .values({ name: 'Lobby', slug: `lobby-${randomUUID()}`, isPublic: true })
      .returning();
    await services.membership.joinPublicRoom({
      roomId: publicRoom!.id,
      userId: ownerId,
      ...NO_CLIENT_META,
    });

    await services.membership.handleAccountClosed({ userId: ownerId, closedAt: new Date() });

    expect((await readMember(publicRoom!.id, ownerId)).accountClosedAt).toBeNull();
    expect((await readRoom(publicRoom!.id))?.scheduledDeletionAt).toBeNull();
  });
});

describe('ChatService.listRoomMembers with a closed account (real PG)', () => {
  it('keeps the closed member on the roster, flagged', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [memberId]);
    await services.membership.handleAccountClosed({ userId: ownerId, closedAt: new Date() });

    const members = await services.chat.listRoomMembers({ roomId: room.id, viewerId: memberId });

    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: ownerId, isDeletedAccount: true }),
        expect.objectContaining({ userId: memberId, isDeletedAccount: false }),
      ]),
    );
  });
});

describe('ChatRoomPurgeService.runCycle (real PG)', () => {
  async function seedRoom(overrides: Partial<typeof chatRoom.$inferInsert>) {
    const [row] = await db.drizzle.db
      .insert(chatRoom)
      .values({ name: 'Room', slug: `room-${randomUUID()}`, isPublic: false, ...overrides })
      .returning();
    return row!;
  }

  it('hard-deletes a room past its deadline together with everything hanging off it', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [memberId]);
    await services.chat.sendRoomMessage({
      userId: memberId,
      username: 'bob',
      roomId: room.id,
      content: 'goodbye',
    });
    // Two of the uncascaded tables; the delete order is what keeps their FKs satisfied.
    await db.drizzle.db.insert(chatPlatformBan).values({
      userId: memberId,
      bannedBy: ownerId,
      scope: 'room',
      roomId: room.id,
      reason: 'spam',
    });
    await db.drizzle.db
      .insert(chatMute)
      .values({ userId: memberId, roomId: room.id, mutedBy: ownerId, reason: 'spam' });
    await db.drizzle.db
      .update(chatRoom)
      .set({ scheduledDeletionAt: new Date(Date.now() - DAY_MS) })
      .where(eq(chatRoom.id, room.id));

    await expect(services.purge.runCycle()).resolves.toEqual({ purged: 1 });

    expect(await readRoom(room.id)).toBeNull();
    expect(
      await db.drizzle.db.select().from(chatMessage).where(eq(chatMessage.roomId, room.id)),
    ).toHaveLength(0);
    expect(
      await db.drizzle.db.select().from(chatRoomMember).where(eq(chatRoomMember.roomId, room.id)),
    ).toHaveLength(0);
    expect(
      await db.drizzle.db.select().from(chatPlatformBan).where(eq(chatPlatformBan.roomId, room.id)),
    ).toHaveLength(0);
    expect(
      await db.drizzle.db.select().from(chatMute).where(eq(chatMute.roomId, room.id)),
    ).toHaveLength(0);
  });

  it('leaves a public room, a null-deadline room and a future-deadline room untouched', async () => {
    const services = makeServices();
    // A public room can never carry a deadline through the handler, but the guard is the
    // only thing standing between this job and every room in the table - so pin it.
    const publicRoom = await seedRoom({
      isPublic: true,
      scheduledDeletionAt: new Date(Date.now() - DAY_MS),
    });
    const noDeadline = await seedRoom({});
    const future = await seedRoom({ scheduledDeletionAt: new Date(Date.now() + DAY_MS) });
    const soft = await seedRoom({
      deletedAt: new Date(),
      scheduledDeletionAt: new Date(Date.now() - DAY_MS),
    });

    await expect(services.purge.runCycle()).resolves.toEqual({ purged: 0 });

    for (const room of [publicRoom, noDeadline, future, soft]) {
      expect(await readRoom(room.id)).not.toBeNull();
    }
  });

  it('emits the purge event carrying the message count', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [memberId]);
    for (const content of ['one', 'two']) {
      await services.chat.sendRoomMessage({
        userId: memberId,
        username: 'bob',
        roomId: room.id,
        content,
      });
    }
    await db.drizzle.db
      .update(chatRoom)
      .set({ scheduledDeletionAt: new Date(Date.now() - DAY_MS) })
      .where(eq(chatRoom.id, room.id));

    await services.purge.runCycle();

    // This event is what writes the audit record - after a hard delete, the room's only
    // surviving trace. The mapping it produces is asserted in audit/__tests__/map-event.
    expect(services.events.emit).toHaveBeenCalledWith('chat.private_room.purged', {
      roomId: room.id,
      messageCount: 2,
    });
  });

  it('purges only what is due, leaving the rest of the countdown running', async () => {
    const services = makeServices();
    const due = await seedRoom({ scheduledDeletionAt: new Date(Date.now() - DAY_MS) });
    const notYet = await seedRoom({ scheduledDeletionAt: new Date(Date.now() + 30 * DAY_MS) });

    await expect(services.purge.runCycle()).resolves.toEqual({ purged: 1 });

    expect(await readRoom(due.id)).toBeNull();
    expect(await readRoom(notYet.id)).not.toBeNull();
  });
});

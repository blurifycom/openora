import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  createTestDb,
  createTestRedis,
  RedisPubSubRealtimeTransport,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import type { DrizzleTx } from '@openora/core/server';
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
import { ChatRoomBanService } from '../service/chat-room-ban.service.js';
import { ChatRoomMembershipService } from '../service/chat-room-membership.service.js';
import { ChatRoomNotModeratorError } from '../service/errors/chat-moderation.errors.js';
import { ChatRoomPurgeService } from '../service/chat-room-purge.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let db: TestDb;
let redis: TestRedis;
const transports: RedisPubSubRealtimeTransport[] = [];

// Matches chat.service.int.test.ts: a real pub/sub transport on an isolated key prefix, so
// the channel revokes the purge fires go through the same code path production uses.
function makeTransport(): RedisPubSubRealtimeTransport {
  const transport = new RedisPubSubRealtimeTransport(
    redis.client,
    `chat-handover-test-${randomUUID()}`,
  );
  transports.push(transport);
  return transport;
}

function makeServices(transport: RealtimeTransport = makeTransport()) {
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
  const purge = new ChatRoomPurgeService(db.drizzle, events, transport, audit);
  const ban = new ChatRoomBanService(db.drizzle, events, audit, transport, identityReader);
  return { chat, membership, purge, ban, events, transport, audit };
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
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((t) => t.close()));
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
    const services = makeServices(Object.assign(makeTransport(), { signal }));
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
    const services = makeServices(Object.assign(makeTransport(), { signal }));
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

    // A second, unrelated closure instant for the same person. Nothing is rewritten, and
    // nothing is re-announced either: the room was not changed by THIS closure, so the
    // re-derivation below declines it.
    await services.membership.handleAccountClosed({
      userId: ownerId,
      closedAt: new Date('2026-09-01T10:00:00.000Z'),
    });

    expect(await readRoom(room.id)).toEqual(afterFirst);
    expect(await readMember(room.id, modId)).toEqual(successorAfterFirst);
    expect(services.events.emit).not.toHaveBeenCalled();
  });
});

// A redelivery is the only thing that can replace an announce lost to a crash between the
// commit and the fan-out, so the second run has to re-announce what the first one wrote -
// without writing anything itself.
describe('handleAccountClosed redelivery (real PG)', () => {
  const CLOSED_AT = new Date('2026-08-31T10:00:00.000Z');

  it('re-announces the countdown a previous delivery committed but may not have sent', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [memberId]);
    await services.membership.handleAccountClosed({ userId: ownerId, closedAt: CLOSED_AT });
    const afterFirst = await readRoom(room.id);
    services.events.emit.mockClear();

    await services.membership.handleAccountClosed({ userId: ownerId, closedAt: CLOSED_AT });

    expect(services.events.emit).toHaveBeenCalledWith(
      'chat.room.scheduled_for_deletion',
      expect.objectContaining({
        roomId: room.id,
        previousOwnerId: ownerId,
        scheduledDeletionAt: afterFirst!.scheduledDeletionAt!.toISOString(),
      }),
    );
    expect(emittedAudience(services)).toEqual([memberId]);
    // Re-announced, not re-run: the deadline is still the one the first delivery wrote.
    expect(await readRoom(room.id)).toEqual(afterFirst);
  });

  it('re-announces a transfer, naming the successor the first delivery installed', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const modId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [modId]);
    await promote(services, room, ownerId, modId);
    await services.membership.handleAccountClosed({ userId: ownerId, closedAt: CLOSED_AT });
    const afterFirst = await readRoom(room.id);
    const successorAfterFirst = await readMember(room.id, modId);
    services.events.emit.mockClear();

    await services.membership.handleAccountClosed({ userId: ownerId, closedAt: CLOSED_AT });

    expect(services.events.emit).toHaveBeenCalledWith('chat.room.ownership.transferred', {
      roomId: room.id,
      roomName: room.name,
      previousOwnerId: ownerId,
      newOwnerId: modId,
      reason: 'account-closed',
    });
    expect(await readRoom(room.id)).toEqual(afterFirst);
    expect(await readMember(room.id, modId)).toEqual(successorAfterFirst);
  });

  it("says nothing about a room somebody else's closure changed", async () => {
    const services = makeServices();
    const firstOwnerId = randomUUID();
    const secondOwnerId = randomUUID();
    const room = await seedPrivateRoom(services, firstOwnerId, [secondOwnerId]);
    await promote(services, room, firstOwnerId, secondOwnerId);
    await services.membership.handleAccountClosed({ userId: firstOwnerId, closedAt: CLOSED_AT });
    // The successor's own closure starts the countdown; a redelivery for the FIRST owner
    // then finds a room on a countdown it did not cause.
    const secondClosedAt = new Date('2026-09-02T10:00:00.000Z');
    await services.membership.handleAccountClosed({
      userId: secondOwnerId,
      closedAt: secondClosedAt,
    });
    services.events.emit.mockClear();

    await services.membership.handleAccountClosed({ userId: firstOwnerId, closedAt: CLOSED_AT });

    expect(services.events.emit).not.toHaveBeenCalled();
  });

  it('leaves a non-owner redelivery silent - there was nothing to announce', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    await seedPrivateRoom(services, ownerId, [memberId]);
    await services.membership.handleAccountClosed({ userId: memberId, closedAt: CLOSED_AT });
    services.events.emit.mockClear();

    await services.membership.handleAccountClosed({ userId: memberId, closedAt: CLOSED_AT });

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

describe('handleAccountClosed against a concurrent membership write (real PG)', () => {
  /** Long enough for a blocked statement to actually be waiting on its lock, not queued in the driver. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  /**
   * Hold the room's advisory lock in a transaction the test controls, standing in for a
   * handover that is mid-flight. `release(work)` runs `work` on that same transaction - so
   * its writes land under the lock, exactly as the handover's do - and then commits.
   */
  function holdRoomLock(roomId: string) {
    let held!: () => void;
    const acquired = new Promise<void>((resolve) => {
      held = resolve;
    });
    let release!: (work: (t: DrizzleTx) => Promise<void>) => void;
    const work = new Promise<(t: DrizzleTx) => Promise<void>>((resolve) => {
      release = resolve;
    });
    const done = db.drizzle.db.transaction(async (t) => {
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`chat-room:${roomId}`}))`);
      held();
      await (
        await work
      )(t);
    });
    return { acquired, release: (w: (t: DrizzleTx) => Promise<void>) => release(w), done };
  }

  /** The two role rows and the creator pointer the handover moves, as one unit. */
  const handoverWrites =
    (roomId: string, closedOwnerId: string, successorId: string) => async (t: DrizzleTx) => {
      await t
        .update(chatRoomMember)
        .set({ role: 'owner', roleAssignedAt: new Date() })
        .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, successorId)));
      await t
        .update(chatRoomMember)
        .set({ role: 'member', roleAssignedAt: null, accountClosedAt: new Date() })
        .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, closedOwnerId)));
      await t.update(chatRoom).set({ creatorId: successorId }).where(eq(chatRoom.id, roomId));
    };

  it('starts the countdown rather than naming a creator whose membership vanished mid-transfer', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const modId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [modId]);
    await promote(services, room, ownerId, modId);
    const closedAt = new Date('2026-08-31T10:00:00.000Z');

    // The one interleaving the room lock cannot cover on its own, reproduced exactly: an
    // uncommitted delete is invisible to the handover's successor SELECT but holds the row
    // lock, so the promotion UPDATE waits on it and then matches nothing. Without the
    // row-count guard the handover still copies `modId` into `creatorId`, and the room is
    // left with a creator who is not a member, no owner on the roster and no deadline.
    let commitDelete!: () => void;
    const deleteCommitted = new Promise<void>((resolve) => {
      commitDelete = resolve;
    });
    const deleting = db.drizzle.db.transaction(async (t) => {
      await t
        .delete(chatRoomMember)
        .where(and(eq(chatRoomMember.roomId, room.id), eq(chatRoomMember.userId, modId)));
      await deleteCommitted;
    });
    await settle();

    const handover = services.membership.handleAccountClosed({ userId: ownerId, closedAt });
    await settle();
    commitDelete();
    await deleting;
    await handover;

    const stored = await readRoom(room.id);
    expect(stored?.creatorId).toBeNull();
    expect(stored?.scheduledDeletionAt?.toISOString()).toBe(
      new Date(closedAt.getTime() + OWNERLESS_ROOM_RETENTION_DAYS * DAY_MS).toISOString(),
    );
  });

  it('makes removeMember wait on the room lock and re-read the roles it was authorized against', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const modId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [modId]);
    await promote(services, room, ownerId, modId);
    const lock = holdRoomLock(room.id);
    await lock.acquired;

    // The closing owner's request, in flight while the handover holds the lock. It has to
    // block: the roles it would authorize against are exactly the ones about to move.
    const removing = services.membership.removeMember({
      moderatorId: ownerId,
      roomId: room.id,
      userId: modId,
      ...NO_CLIENT_META,
    });
    const outcome = removing.then(
      () => 'settled',
      () => 'settled',
    );
    expect(await Promise.race([outcome, settle().then(() => 'blocked')])).toBe('blocked');

    lock.release(handoverWrites(room.id, ownerId, modId));
    await lock.done;

    await expect(removing).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
    expect((await readMember(room.id, modId)).role).toBe('owner');
    expect((await readRoom(room.id))?.creatorId).toBe(modId);
  });

  it('authorizes banMember inside the room lock, so a demoted owner cannot ban their successor', async () => {
    const services = makeServices();
    const ownerId = randomUUID();
    const modId = randomUUID();
    const room = await seedPrivateRoom(services, ownerId, [modId]);
    await promote(services, room, ownerId, modId);
    const lock = holdRoomLock(room.id);
    await lock.acquired;

    const banning = services.ban.banMember({
      moderatorId: ownerId,
      roomId: room.id,
      userId: modId,
      ...NO_CLIENT_META,
    });
    const outcome = banning.then(
      () => 'settled',
      () => 'settled',
    );
    expect(await Promise.race([outcome, settle().then(() => 'blocked')])).toBe('blocked');

    lock.release(handoverWrites(room.id, ownerId, modId));
    await lock.done;

    // The ban that was authorized before the lock would have deleted the member row of the
    // owner the handover had just installed, leaving `creatorId` pointing off the roster.
    await expect(banning).rejects.toBeInstanceOf(ChatRoomNotModeratorError);
    expect(await readMember(room.id, modId)).toMatchObject({ role: 'owner' });
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

describe('ChatRoomPurgeService (real PG)', () => {
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
    // chat_platform_ban now cascades with the room; chat_mute has no FK at all and is the
    // one table the purge still deletes by hand. Both are asserted gone below.
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

    await expect(services.purge.purgeRoom(room.id)).resolves.toBe(true);

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

    await expect(services.purge.listDueRooms(100)).resolves.toEqual([]);
    // The scan is only half the guard - a job carrying any of these ids must still refuse
    // to delete, because the id was selected outside the lock the purge takes.
    for (const room of [publicRoom, noDeadline, future, soft]) {
      await expect(services.purge.purgeRoom(room.id)).resolves.toBe(false);
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

    await services.purge.purgeRoom(room.id);

    // The audit record is the room's only surviving trace, so it is written inside the
    // deleting transaction rather than derived from the event after the fact.
    expect(services.audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'system',
        action: 'chat.private_room.purged',
        resourceType: 'chat_room',
        resourceId: room.id,
        after: { messageCount: 2 },
      }),
    );
    // The event stays, for overlays and clients - it just no longer carries the trace.
    expect(services.events.emit).toHaveBeenCalledWith('chat.private_room.purged', {
      roomId: room.id,
      messageCount: 2,
    });
  });

  it('takes the room down with the audit write when the audit write fails', async () => {
    const services = makeServices();
    const room = await seedRoom({ scheduledDeletionAt: new Date(Date.now() - DAY_MS) });
    vi.mocked(services.audit.recordInTransaction).mockRejectedValueOnce(new Error('audit down'));

    await expect(services.purge.purgeRoom(room.id)).rejects.toThrow('audit down');

    // Untraceable deletion is the one outcome this job must never produce, so the room
    // survives to be retried rather than vanishing without a record.
    expect(await readRoom(room.id)).not.toBeNull();
  });

  it('hands out only what is due, leaving the rest of the countdown running', async () => {
    const services = makeServices();
    const due = await seedRoom({ scheduledDeletionAt: new Date(Date.now() - DAY_MS) });
    const notYet = await seedRoom({ scheduledDeletionAt: new Date(Date.now() + 30 * DAY_MS) });

    await expect(services.purge.listDueRooms(100)).resolves.toEqual([due.id]);

    await services.purge.purgeRoom(due.id);
    expect(await readRoom(due.id)).toBeNull();
    expect(await readRoom(notYet.id)).not.toBeNull();
  });

  it('caps one tick at the batch limit, oldest deadline first', async () => {
    const services = makeServices();
    const oldest = await seedRoom({ scheduledDeletionAt: new Date(Date.now() - 3 * DAY_MS) });
    const middle = await seedRoom({ scheduledDeletionAt: new Date(Date.now() - 2 * DAY_MS) });
    await seedRoom({ scheduledDeletionAt: new Date(Date.now() - DAY_MS) });

    // A backlog after downtime is drained across ticks; nothing is lost by waiting a day,
    // and one tick never serially chews through the whole table.
    await expect(services.purge.listDueRooms(2)).resolves.toEqual([oldest.id, middle.id]);
  });

  it('is a no-op the second time a job runs for the same room', async () => {
    const services = makeServices();
    const room = await seedRoom({ scheduledDeletionAt: new Date(Date.now() - DAY_MS) });

    await expect(services.purge.purgeRoom(room.id)).resolves.toBe(true);
    await expect(services.purge.purgeRoom(room.id)).resolves.toBe(false);
    expect(services.audit.recordInTransaction).toHaveBeenCalledTimes(1);
  });
});

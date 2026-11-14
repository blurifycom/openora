import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
  type DrizzleTx,
} from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  CHAT_BLOCK_WRITER,
  CHAT_CONTEXT_SEND_POLICY,
  CHAT_TRANSFER_CHECK,
  CHAT_TRANSFER_MAX_COUNTERPARTS,
  GLOBAL_CHAT_ROOM_ID,
  IDENTITY_READER,
  REALTIME_TRANSPORT,
  type AdminUserDirectory,
  type ChatTransferCheckInput,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import {
  chatMute,
  chatPlatformBan,
  chatRoom,
  chatRoomBan,
  chatRoomMember,
  chatRoomMute,
  chatUserBlock,
} from '@openora/core/engagement/schema/chat';
import chatPlugin from '@openora/core/engagement/plugins/chat';
import {
  makeAuditWriter,
  makeChatContextSendPolicy,
  makeEventBus,
  makeIdentityReader,
  makeRealtimeTransport,
  mock,
} from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { chatCommandConfig } from '../schema/index.js';
import chatCommandsPlugin from '../plugin.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateChat, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${chatUserBlock}, ${chatCommandConfig}, ${chatPlatformBan}, ${chatRoomBan}, ${chatMute}, ${chatRoomMute} CASCADE`,
  );
  await db.drizzle.db.delete(chatRoom).where(sql`${chatRoom.slug} <> ${GLOBAL_CHAT_ROOM_ID}`);
  await db.drizzle.db.insert(chatCommandConfig).values([
    { key: 'gift', label: 'gift', config: { maxRecipients: 1 } },
    { key: 'rain', label: 'rain', enabled: false },
  ]);
});

function boot(contextSendPolicy = makeChatContextSendPolicy()) {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => makeEventBus());
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(REALTIME_TRANSPORT, () => makeRealtimeTransport());
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(ADMIN_USER_DIRECTORY, () =>
    mock<AdminUserDirectory>({ lookupPlayers: async () => [] }),
  );
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  chatPlugin.register(registry);
  chatCommandsPlugin.register(registry);
  container.register(CHAT_CONTEXT_SEND_POLICY, () => contextSendPolicy);
  const transferCheck = container.get(CHAT_TRANSFER_CHECK);
  return {
    check: (input: ChatTransferCheckInput) =>
      db.drizzle.db.transaction((tx) => transferCheck.check(tx, input)),
    transferCheck,
    blockWriter: container.get(CHAT_BLOCK_WRITER),
  };
}

async function globalRoomId() {
  const [row] = await db.drizzle.db
    .select({ id: chatRoom.id })
    .from(chatRoom)
    .where(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID));
  return row.id;
}

async function room(values: Partial<typeof chatRoom.$inferInsert> = {}, memberIds: string[] = []) {
  const [created] = await db.drizzle.db
    .insert(chatRoom)
    .values({ name: 'room', slug: `room-${randomUUID()}`, ...values })
    .returning({ id: chatRoom.id });
  if (memberIds.length > 0) {
    await db.drizzle.db
      .insert(chatRoomMember)
      .values(memberIds.map((userId) => ({ roomId: created.id, userId })));
  }
  return created.id;
}

const gift = (over: Partial<ChatTransferCheckInput> = {}): ChatTransferCheckInput => ({
  actorId: randomUUID(),
  roomId: null,
  counterpartIds: [],
  command: 'gift',
  ...over,
});

describe('CHAT_TRANSFER_CHECK local binding', () => {
  it('names each counterpart in a block with the actor once, either direction, never the actor', async () => {
    const { check } = boot();
    const actorId = randomUUID();
    const [blockedByActor, blockingActor, clear] = [randomUUID(), randomUUID(), randomUUID()];
    await db.drizzle.db.insert(chatUserBlock).values([
      { blockerId: actorId, blockedId: blockedByActor },
      { blockerId: blockingActor, blockedId: actorId },
    ]);

    const verdict = await check(
      gift({
        actorId,
        counterpartIds: [blockedByActor, blockingActor, clear, actorId, blockedByActor, actorId],
      }),
    );

    expect(verdict).toEqual({
      allowed: true,
      canonicalRoomId: null,
      contextRef: null,
      blockedIds: [blockedByActor, blockingActor],
      commandConfig: { maxRecipients: 1 },
    });
  });

  it('ignores a lifted block', async () => {
    const { check } = boot();
    const actorId = randomUUID();
    const counterpartId = randomUUID();
    await db.drizzle.db
      .insert(chatUserBlock)
      .values({ blockerId: actorId, blockedId: counterpartId, removedAt: new Date() });

    await expect(check(gift({ actorId, counterpartIds: [counterpartId] }))).resolves.toMatchObject({
      allowed: true,
      blockedIds: [],
    });
  });

  it('rejects more counterparts than the cap before taking any lock', async () => {
    const { check } = boot();
    const counterpartIds = Array.from({ length: CHAT_TRANSFER_MAX_COUNTERPARTS + 1 }, () =>
      randomUUID(),
    );

    await expect(check(gift({ counterpartIds }))).rejects.toBeInstanceOf(ZodError);
  });

  it('throws without the caller transaction instead of answering unlocked', async () => {
    const { transferCheck } = boot();

    await expect(transferCheck.check(undefined, gift())).rejects.toThrow(
      'needs the caller transaction',
    );
  });

  it('refuses an actor who is not a member of a private room', async () => {
    const { check } = boot();
    const memberId = randomUUID();
    const roomId = await room({ isPublic: false }, [memberId]);

    await expect(check(gift({ roomId }))).resolves.toEqual({
      allowed: false,
      refusal: 'room_access_denied',
    });
    await expect(check(gift({ actorId: memberId, roomId }))).resolves.toMatchObject({
      allowed: true,
      canonicalRoomId: roomId,
    });
  });

  it('refuses a room that does not exist', async () => {
    const { check } = boot();

    await expect(check(gift({ roomId: randomUUID() }))).resolves.toEqual({
      allowed: false,
      refusal: 'room_not_found',
    });
  });

  it('refuses a command switched off, or with no config row', async () => {
    const { check } = boot();

    await expect(check(gift({ command: 'rain' }))).resolves.toEqual({
      allowed: false,
      refusal: 'command_disabled',
    });
    await expect(check(gift({ command: 'donate' }))).resolves.toEqual({
      allowed: false,
      refusal: 'command_disabled',
    });
  });

  it('refuses a command whose stored limits no longer parse, and allows one with none stored', async () => {
    const { check } = boot();
    await db.drizzle.db.execute(
      sql`INSERT INTO ${chatCommandConfig} (key, label, config) VALUES ('donate', 'donate', '{"maxAmount": {"not": "a decimal"}}'::jsonb)`,
    );

    await expect(check(gift({ command: 'donate' }))).resolves.toEqual({
      allowed: false,
      refusal: 'command_disabled',
    });

    await db.drizzle.db
      .update(chatCommandConfig)
      .set({ config: null })
      .where(sql`${chatCommandConfig.key} = 'donate'`);

    await expect(check(gift({ command: 'donate' }))).resolves.toMatchObject({
      allowed: true,
      commandConfig: {},
    });
  });

  it('answers the global room as null whether addressed by null or by its row id', async () => {
    const { check } = boot();

    await expect(check(gift())).resolves.toMatchObject({ allowed: true, canonicalRoomId: null });
    await expect(check(gift({ roomId: await globalRoomId() }))).resolves.toMatchObject({
      allowed: true,
      canonicalRoomId: null,
    });
  });

  describe('a banned actor is refused', () => {
    const rooms = {
      global: async () => ({ roomId: null, banRoomId: await globalRoomId() }),
      public: async () => {
        const roomId = await room();
        return { roomId, banRoomId: roomId };
      },
      private: async (actorId: string) => {
        const roomId = await room({ isPublic: false }, [actorId]);
        return { roomId, banRoomId: roomId };
      },
    };
    const platformScopes = {
      global: '__global',
      public: '__all_public',
      private: '__all',
    } as const;

    it.each(Object.keys(rooms) as (keyof typeof rooms)[])(
      'room ban in the %s room',
      async (kind) => {
        const { check } = boot();
        const actorId = randomUUID();
        const { roomId, banRoomId } = await rooms[kind](actorId);
        await db.drizzle.db
          .insert(chatRoomBan)
          .values({ roomId: banRoomId, userId: actorId, bannedBy: randomUUID() });

        await expect(check(gift({ actorId, roomId }))).resolves.toEqual({
          allowed: false,
          refusal: 'room_access_denied',
        });
      },
    );

    it.each(Object.keys(rooms) as (keyof typeof rooms)[])(
      'platform ban covering the %s room',
      async (kind) => {
        const { check } = boot();
        const actorId = randomUUID();
        const { roomId } = await rooms[kind](actorId);
        await db.drizzle.db.insert(chatPlatformBan).values({
          userId: actorId,
          bannedBy: randomUUID(),
          scope: platformScopes[kind],
          reason: 'spam',
        });

        await expect(check(gift({ actorId, roomId }))).resolves.toEqual({
          allowed: false,
          refusal: 'room_access_denied',
        });
      },
    );
  });

  it('reads bans through the caller transaction', async () => {
    const { transferCheck } = boot();
    const actorId = randomUUID();
    const roomId = await room();

    const verdict = await db.drizzle.db.transaction(async (tx: DrizzleTx) => {
      await tx.insert(chatRoomBan).values({ roomId, userId: actorId, bannedBy: randomUUID() });
      return transferCheck.check(tx, gift({ actorId, roomId }));
    });

    expect(verdict).toEqual({ allowed: false, refusal: 'room_access_denied' });
  });

  it('lets a muted actor through, as chat transfers do today', async () => {
    const { check } = boot();
    const actorId = randomUUID();
    const roomId = await room();
    await db.drizzle.db.insert(chatMute).values({
      userId: actorId,
      roomId: null,
      scope: '__global',
      mutedBy: randomUUID(),
      reason: 'spam',
    });
    await db.drizzle.db
      .insert(chatRoomMute)
      .values({ roomId, userId: actorId, mutedBy: randomUUID(), reason: 'spam' });

    await expect(check(gift({ actorId }))).resolves.toMatchObject({ allowed: true });
    await expect(check(gift({ actorId, roomId }))).resolves.toMatchObject({ allowed: true });
  });

  it('returns a context room contextRef, and refuses with the policy reason when it denies', async () => {
    const actorId = randomUUID();
    const contextRef = `match:${randomUUID()}`;
    const roomId = await room({ kind: 'context', contextRef, isPublic: false }, [actorId]);

    await expect(boot().check(gift({ actorId, roomId }))).resolves.toMatchObject({
      allowed: true,
      canonicalRoomId: roomId,
      contextRef,
    });

    const denying = boot(
      makeChatContextSendPolicy(async () => ({ allowed: false, reason: 'match_closed' })),
    );
    await expect(denying.check(gift({ actorId, roomId }))).resolves.toEqual({
      allowed: false,
      refusal: 'context_send_denied',
      policyReason: 'match_closed',
    });
  });

  it('holds a block issued during the transfer until the transfer commits', async () => {
    const { transferCheck, blockWriter } = boot();
    const actorId = randomUUID();
    const counterpartId = randomUUID();
    const order: string[] = [];
    let blockDone: Promise<unknown> = Promise.resolve();

    await db.drizzle.db.transaction(async (tx) => {
      const verdict = await transferCheck.check(
        tx,
        gift({ actorId, counterpartIds: [counterpartId] }),
      );
      expect(verdict).toMatchObject({ allowed: true, blockedIds: [] });
      blockDone = blockWriter.blockUser(counterpartId, actorId).then(() => order.push('block'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push('transfer');
    });
    await blockDone;

    expect(order).toEqual(['transfer', 'block']);
  });
});

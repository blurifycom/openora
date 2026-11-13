import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  CHAT_BLOCK_WRITER,
  CHAT_TRANSFER_CHECK,
  GLOBAL_CHAT_ROOM_ID,
  IDENTITY_READER,
  REALTIME_TRANSPORT,
  type AdminUserDirectory,
  type ChatTransferCheckInput,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import { chatRoom, chatRoomMember, chatUserBlock } from '@openora/core/engagement/schema/chat';
import chatPlugin from '@openora/core/engagement/plugins/chat';
import {
  makeAuditWriter,
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
  await db.drizzle.db.execute(sql`TRUNCATE ${chatUserBlock}, ${chatCommandConfig} CASCADE`);
  await db.drizzle.db.delete(chatRoom).where(sql`${chatRoom.slug} <> ${GLOBAL_CHAT_ROOM_ID}`);
  await db.drizzle.db.insert(chatCommandConfig).values([
    { key: 'gift', label: 'gift', config: { maxRecipients: 1 } },
    { key: 'rain', label: 'rain', enabled: false },
  ]);
});

function boot() {
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
  return {
    transferCheck: container.get(CHAT_TRANSFER_CHECK),
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

async function privateRoom(memberIds: string[]) {
  const [room] = await db.drizzle.db
    .insert(chatRoom)
    .values({ name: 'private', slug: `private-${randomUUID()}`, isPublic: false })
    .returning({ id: chatRoom.id });
  if (memberIds.length > 0) {
    await db.drizzle.db
      .insert(chatRoomMember)
      .values(memberIds.map((userId) => ({ roomId: room.id, userId })));
  }
  return room.id;
}

const gift = (over: Partial<ChatTransferCheckInput> = {}): ChatTransferCheckInput => ({
  actorId: randomUUID(),
  roomId: null,
  counterpartIds: [],
  command: 'gift',
  ...over,
});

describe('CHAT_TRANSFER_CHECK local binding', () => {
  it('names the counterparts in a block with the actor, in either direction', async () => {
    const { transferCheck } = boot();
    const actorId = randomUUID();
    const [blockedByActor, blockingActor, clear] = [randomUUID(), randomUUID(), randomUUID()];
    await db.drizzle.db.insert(chatUserBlock).values([
      { blockerId: actorId, blockedId: blockedByActor },
      { blockerId: blockingActor, blockedId: actorId },
    ]);

    const verdict = await db.drizzle.db.transaction((tx) =>
      transferCheck.check(
        tx,
        gift({ actorId, counterpartIds: [blockedByActor, blockingActor, clear, actorId] }),
      ),
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
    const { transferCheck } = boot();
    const actorId = randomUUID();
    const counterpartId = randomUUID();
    await db.drizzle.db
      .insert(chatUserBlock)
      .values({ blockerId: actorId, blockedId: counterpartId, removedAt: new Date() });

    const verdict = await transferCheck.check(
      undefined,
      gift({ actorId, counterpartIds: [counterpartId] }),
    );

    expect(verdict).toMatchObject({ allowed: true, blockedIds: [] });
  });

  it('refuses an actor who is not a member of a private room', async () => {
    const { transferCheck } = boot();
    const memberId = randomUUID();
    const roomId = await privateRoom([memberId]);

    await expect(transferCheck.check(undefined, gift({ roomId }))).resolves.toEqual({
      allowed: false,
      refusal: 'room_access_denied',
    });
    await expect(
      transferCheck.check(undefined, gift({ actorId: memberId, roomId })),
    ).resolves.toMatchObject({ allowed: true, canonicalRoomId: roomId });
  });

  it('refuses a room that does not exist', async () => {
    const { transferCheck } = boot();

    await expect(transferCheck.check(undefined, gift({ roomId: randomUUID() }))).resolves.toEqual({
      allowed: false,
      refusal: 'room_not_found',
    });
  });

  it('refuses a command switched off, or with no config row', async () => {
    const { transferCheck } = boot();

    await expect(transferCheck.check(undefined, gift({ command: 'rain' }))).resolves.toEqual({
      allowed: false,
      refusal: 'command_disabled',
    });
    await expect(transferCheck.check(undefined, gift({ command: 'donate' }))).resolves.toEqual({
      allowed: false,
      refusal: 'command_disabled',
    });
  });

  it('answers the global room as null whether addressed by null or by its row id', async () => {
    const { transferCheck } = boot();

    await expect(transferCheck.check(undefined, gift())).resolves.toMatchObject({
      allowed: true,
      canonicalRoomId: null,
    });
    await expect(
      transferCheck.check(undefined, gift({ roomId: await globalRoomId() })),
    ).resolves.toMatchObject({ allowed: true, canonicalRoomId: null });
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

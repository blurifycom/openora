import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import {
  chatBlockLockKey,
  checkChatTransfer,
  ChatTransferCheckUnavailableError,
  type ChatTransferCheck,
  type ChatTransferCheckInput,
} from '@openora/core/contracts';
import { type InternalContext, withAdvisoryXactLock } from '@openora/core/server';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import { chatRoom, chatRoomBan, chatUserBlock } from '@openora/core/engagement/schema/chat';
import {
  createTestDb,
  waitForAdvisoryLockWaiter,
  type TestDb,
} from '../../../testing/real-infra.js';
import { migrate as migrateChatCommands } from '../migrate.js';
import { chatCommandConfig } from '../schema/index.js';
import { createInternalTransferCheckRouter } from '../router/internal-transfer-check.router.js';
import { ChatTransferCheckService } from '../service/chat-transfer-check.service.js';

type TransferCommand = ChatTransferCheckInput['command'];

let testDb: TestDb;
let transferCheck: ChatTransferCheckService;

beforeAll(async () => {
  testDb = await createTestDb([migrateChat, migrateChatCommands]);
  transferCheck = new ChatTransferCheckService({
    roomAccess: {
      verifyRoomAccess: async (roomId, viewerId) => {
        const rooms = await testDb.drizzle.db
          .select({ id: chatRoom.id })
          .from(chatRoom)
          .where(eq(chatRoom.id, roomId));
        if (rooms.length === 0) {
          throw new ORPCError('NOT_FOUND');
        }
        const bans = await testDb.drizzle.db
          .select({ id: chatRoomBan.id })
          .from(chatRoomBan)
          .where(
            and(
              eq(chatRoomBan.roomId, roomId),
              eq(chatRoomBan.userId, viewerId ?? ''),
              isNull(chatRoomBan.liftedAt),
              or(isNull(chatRoomBan.expiresAt), gt(chatRoomBan.expiresAt, new Date())),
            ),
          );
        if (bans.length > 0) {
          throw new ORPCError('FORBIDDEN');
        }
      },
    },
    contextSendPolicy: { check: async () => ({ allowed: true }) },
  });
}, 120_000);

afterAll(async () => {
  await testDb.drop();
}, 60_000);

const db = () => testDb.drizzle.db;

async function seedRoom() {
  const slug = `room-${randomUUID()}`;
  const [room] = await db()
    .insert(chatRoom)
    .values({ name: slug, slug, isPublic: true })
    .returning();
  if (!room) {
    throw new Error('seedRoom: no row');
  }
  return room;
}

async function setCommand(key: TransferCommand, enabled: boolean) {
  await db()
    .insert(chatCommandConfig)
    .values({ key, enabled, label: key })
    .onConflictDoUpdate({ target: chatCommandConfig.key, set: { enabled } });
}

const runCheck = (input: ChatTransferCheckInput) =>
  testDb.drizzle.db.transaction((tx) => transferCheck.check(tx, input));

function inputFor(
  roomId: string | null,
  actorId: string,
  counterpartIds: string[] = [],
  command: TransferCommand = 'gift',
): ChatTransferCheckInput {
  return { actorId, roomId, counterpartIds, command };
}

describe('chat transfer check', () => {
  it('a disabled command is refused', async () => {
    const room = await seedRoom();
    const actor = randomUUID();
    await setCommand('rain', false);
    await setCommand('donate', true);

    const disabled = await runCheck(inputFor(room.id, actor, [], 'rain'));
    const enabled = await runCheck(inputFor(room.id, actor, [], 'donate'));

    expect(disabled).toEqual({ allowed: false, refusal: 'command_disabled' });
    expect(enabled).toMatchObject({ allowed: true });
  });

  it('an actor banned from the room is refused', async () => {
    const room = await seedRoom();
    const banned = randomUUID();
    const bystander = randomUUID();
    await setCommand('gift', true);
    await db()
      .insert(chatRoomBan)
      .values({ roomId: room.id, userId: banned, bannedBy: randomUUID() });

    const refused = await runCheck(inputFor(room.id, banned));
    const allowed = await runCheck(inputFor(room.id, bystander));

    expect(refused).toEqual({ allowed: false, refusal: 'room_access_denied' });
    expect(allowed).toMatchObject({ allowed: true });
  });

  it('a counterpart blocked by the actor or blocking the actor is reported', async () => {
    const room = await seedRoom();
    const actor = randomUUID();
    const blockedByActor = randomUUID();
    const blockingActor = randomUUID();
    const unrelated = randomUUID();
    const unblocked = randomUUID();
    await setCommand('gift', true);
    await db()
      .insert(chatUserBlock)
      .values([
        { blockerId: actor, blockedId: blockedByActor },
        { blockerId: blockingActor, blockedId: actor },
        { blockerId: actor, blockedId: unblocked, removedAt: new Date() },
      ]);

    const verdict = await runCheck(
      inputFor(room.id, actor, [blockedByActor, blockingActor, unrelated, unblocked]),
    );

    expect(verdict).toMatchObject({ allowed: true });
    if (!verdict.allowed) {
      throw new Error('expected an allowed verdict');
    }
    expect([...verdict.blockedIds].sort()).toEqual([blockedByActor, blockingActor].sort());
  });

  it('counterparts above the cap are refused', async () => {
    const room = await seedRoom();
    const actor = randomUUID();
    await setCommand('gift', true);
    const ids = Array.from({ length: 501 }, () => randomUUID());

    const atCap = await runCheck(inputFor(room.id, actor, ids.slice(0, 500)));
    const overCap = runCheck(inputFor(room.id, actor, ids));

    expect(atCap).toMatchObject({ allowed: true, blockedIds: [] });
    await expect(overCap).rejects.toThrow();
  });

  it('a concurrent block waits for the transfer transaction to commit', async () => {
    await setCommand('gift', true);
    const directions = ['actor-blocks', 'counterpart-blocks'] as const;

    for (const direction of directions) {
      const room = await seedRoom();
      const actor = randomUUID();
      const counterpart = randomUUID();
      const blockerId = direction === 'actor-blocks' ? actor : counterpart;
      const blockedId = direction === 'actor-blocks' ? counterpart : actor;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let checked: () => void = () => {};
      const checkDone = new Promise<void>((resolve) => {
        checked = resolve;
      });
      const transfer = testDb.drizzle.db.transaction(async (tx) => {
        const verdict = await transferCheck.check(tx, inputFor(room.id, actor, [counterpart]));
        checked();
        await gate;
        return verdict;
      });
      await checkDone;

      const blocking = testDb.drizzle.db.transaction((tx) =>
        withAdvisoryXactLock(tx, chatBlockLockKey(blockerId, blockedId), () =>
          tx.insert(chatUserBlock).values({ blockerId, blockedId }),
        ),
      );
      await waitForAdvisoryLockWaiter(testDb);
      const activeWhileWaiting = await db()
        .select({ id: chatUserBlock.id })
        .from(chatUserBlock)
        .where(and(eq(chatUserBlock.blockerId, blockerId), isNull(chatUserBlock.removedAt)));
      release();
      const verdict = await transfer;
      await blocking;
      const activeAfter = await db()
        .select({ blockedId: chatUserBlock.blockedId })
        .from(chatUserBlock)
        .where(and(eq(chatUserBlock.blockerId, blockerId), isNull(chatUserBlock.removedAt)));

      expect(activeWhileWaiting).toEqual([]);
      expect(verdict).toMatchObject({ allowed: true, blockedIds: [] });
      expect(activeAfter).toEqual([{ blockedId }]);
    }
  });

  it('an unanswered remote check refuses as unavailable', async () => {
    const input = inputFor(randomUUID(), randomUUID(), [randomUUID()]);
    const unanswered: ChatTransferCheck = {
      check: async () => {
        throw new ChatTransferCheckUnavailableError({ cause: new Error('request timed out') });
      },
    };
    const faulty: ChatTransferCheck = {
      check: async () => {
        throw new Error('unexpected fault');
      },
    };

    const verdict = await checkChatTransfer(unanswered, null, input);

    expect(verdict).toEqual({ allowed: false, refusal: 'chat_unavailable' });
    await expect(checkChatTransfer(faulty, null, input)).rejects.toThrow('unexpected fault');
  });

  it('a caller service outside the allowed list is refused on the internal route', async () => {
    const room = await seedRoom();
    await setCommand('gift', true);
    const router = createInternalTransferCheckRouter(
      transferCheck,
      testDb.drizzle,
      new Set(['wallet']),
    );
    const input = inputFor(room.id, randomUUID());
    const asCaller = (internalCaller: string) => {
      const context: InternalContext = {
        request: { headers: {} },
        clientMeta: { ip: null, userAgent: null },
        internalCaller,
      };
      return { context };
    };

    const outsider = await call(router.check, input, asCaller('sportsbook')).catch(
      (error: unknown) => error,
    );
    const listed = await call(router.check, input, asCaller('wallet'));

    expect(outsider).toBeInstanceOf(ORPCError);
    expect(outsider).toMatchObject({ code: 'FORBIDDEN' });
    expect(listed).toMatchObject({ allowed: true });
  });
});

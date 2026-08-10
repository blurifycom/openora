import { describe, it, expect, vi } from 'vitest';
import { mock, makeDrizzle, makeEventBus } from '../../../../testing/mock.js';
import type {
  CommandChatMessage,
  ChatSystemWriter,
  WalletCommands,
  AdminUserDirectory,
  AuditWritePort,
  RealtimeTransport,
  ChatRoomAccess,
  CacheAdapter,
} from '@openora/core/contracts';
import {
  SocialTransfersService,
  InsufficientBalanceError,
  BelowMinimumError,
  DonateSelfError,
  ChatPlayerNotFoundError,
  fingerprintCommand,
} from '../social-transfers.service.js';

const ACTOR_ID = '00000000-0000-0000-0000-000000000001';
const CLAIMER_ID = '00000000-0000-0000-0000-000000000002';
const RECIPIENT_2 = '00000000-0000-0000-0000-000000000006';
const ROOM_ID = '00000000-0000-0000-0000-000000000003';
const MSG_ID = '00000000-0000-0000-0000-000000000004';
const GIFT_ID = '00000000-0000-0000-0000-000000000005';
const OTHER_ROOM_ID = '00000000-0000-0000-0000-000000000009';

const ENABLED_ROW = {
  key: 'gift',
  enabled: true,
  label: 'Gift',
  description: null,
  config: null,
  updatedAt: new Date(),
};

const DISABLED_ROW = { ...ENABLED_ROW, enabled: false };

const SYSTEM_MSG: CommandChatMessage = {
  id: MSG_ID,
  roomId: ROOM_ID,
  actorId: ACTOR_ID,
  userId: ACTOR_ID,
  username: 'system',
  content: '',
  type: 'system',
  isDeleted: false,
  metadata: {
    command: 'gift',
    giftId: GIFT_ID,
    senderId: ACTOR_ID,
    senderUsername: 'bob',
    amount: '10.00000000',
    currency: 'USD',
    status: 'available',
    claimedBy: null,
    claimedByUsername: null,
    claimedAt: null,
  },
  createdAt: new Date().toISOString(),
};

/** Gift row as returned from the DB (dates as Date objects, amount as string). */
const GIFT_ROW = {
  id: GIFT_ID,
  messageId: MSG_ID,
  senderId: ACTOR_ID,
  senderUsername: 'bob',
  amount: '10.00000000',
  currency: 'USD',
  roomId: ROOM_ID,
  claimedBy: null,
  claimedByUsername: null,
  claimedAt: null,
  createdAt: new Date(),
};

function makeWriter(): ChatSystemWriter {
  return mock<ChatSystemWriter>({
    postSystemMessage: vi.fn().mockResolvedValue(SYSTEM_MSG),
    updateSystemMessage: vi.fn().mockResolvedValue(SYSTEM_MSG),
  });
}

function makeWallet(ok = true): WalletCommands {
  return mock<WalletCommands>({
    debit: vi
      .fn()
      .mockResolvedValue(
        ok
          ? { ok: true, newBalance: '90.00000000', currency: 'USD' }
          : { ok: false, available: '5.00000000' },
      ),
    credit: vi.fn().mockResolvedValue({ ok: true, newBalance: '110.00000000' }),
  });
}

const DIRECTORY_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

function makeDirectory(
  senderUsername = 'bob',
  claimerUsername = 'alice',
  extraUserIds: string[] = [],
): AdminUserDirectory {
  const all = [
    {
      userId: ACTOR_ID,
      username: senderUsername,
      email: 'bob@example.com',
      kycStatus: null,
      language: null,
      avatarUrl: null,
      createdAt: DIRECTORY_CREATED_AT,
      level: 3,
      currency: 'USD',
    },
    {
      userId: CLAIMER_ID,
      username: claimerUsername,
      email: 'alice@example.com',
      kycStatus: null,
      language: null,
      avatarUrl: null,
      createdAt: DIRECTORY_CREATED_AT,
      level: 1,
      currency: 'USD',
    },
    {
      userId: RECIPIENT_2,
      username: 'charlie',
      email: 'charlie@example.com',
      kycStatus: null,
      language: null,
      avatarUrl: null,
      createdAt: DIRECTORY_CREATED_AT,
      level: 1,
      currency: 'USD',
    },
    ...extraUserIds.map((userId, index) => ({
      userId,
      username: `player${index}`,
      email: `player${index}@example.com`,
      kycStatus: null,
      language: null,
      avatarUrl: null,
      createdAt: DIRECTORY_CREATED_AT,
      level: 1,
      currency: 'USD',
    })),
  ];
  return mock<AdminUserDirectory>({
    findPlayerIds: vi.fn().mockResolvedValue([ACTOR_ID]),
    lookupPlayers: vi.fn().mockImplementation((ids: string[]) => {
      return Promise.resolve(all.filter((p) => ids.includes(p.userId)));
    }),
    getPlayerByUsername: vi.fn().mockImplementation((username: string) => {
      return Promise.resolve(
        all.find((p) => p.username.toLowerCase() === username.toLowerCase()) ?? null,
      );
    }),
  });
}

function makeAudit(): AuditWritePort {
  return mock<AuditWritePort>({
    record: vi.fn().mockResolvedValue(undefined),
    recordInTransaction: vi.fn().mockResolvedValue(undefined),
  });
}

function makeTransport(onlineIds: string[] = [CLAIMER_ID]): RealtimeTransport {
  return mock<RealtimeTransport>({
    getOnlineUserIds: vi.fn().mockResolvedValue(onlineIds),
    publish: vi.fn().mockResolvedValue(undefined),
  });
}

function makeRoomAccess(): ChatRoomAccess {
  return mock<ChatRoomAccess>({ verifyRoomAccess: vi.fn().mockResolvedValue(undefined) });
}

function makeCache(initial: Record<string, unknown> = {}): CacheAdapter {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    get: async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined,
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    setIfAbsent: vi.fn(async (key: string, value: unknown) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    }),
    delete: vi.fn(async (key: string | string[]) => {
      for (const item of Array.isArray(key) ? key : [key]) {
        values.delete(item);
      }
    }),
  };
}

function makeSvc(
  overrides: {
    drizzleRows?: {
      select?: Record<string, unknown>[][];
      returning?: Record<string, unknown>[][];
      execute?: Record<string, unknown>[][];
    };
    writer?: ChatSystemWriter;
    wallet?: WalletCommands;
    directory?: AdminUserDirectory;
    transport?: RealtimeTransport;
    audit?: AuditWritePort;
    roomAccess?: ChatRoomAccess;
    cache?: CacheAdapter;
  } = {},
) {
  const drizzle = makeDrizzle({
    select: overrides.drizzleRows?.select ?? [],
    returning: overrides.drizzleRows?.returning ?? [],
    execute: overrides.drizzleRows?.execute,
  });
  return new SocialTransfersService(
    drizzle,
    overrides.writer ?? makeWriter(),
    overrides.wallet ?? makeWallet(),
    overrides.directory ?? makeDirectory(),
    overrides.audit ?? makeAudit(),
    overrides.transport ?? makeTransport(),
    mock(makeEventBus()),
    overrides.roomAccess ?? makeRoomAccess(),
    overrides.cache ?? makeCache(),
  );
}

const IDEMPOTENCY_KEY = '00000000-0000-0000-0000-0000000000aa';
const IDEMPOTENCY_CACHE_KEY = `chat-command:idempotency:${ACTOR_ID}:gift:${IDEMPOTENCY_KEY}`;
const RAIN_IDEMPOTENCY_CACHE_KEY = `chat-command:idempotency:${ACTOR_ID}:rain:${IDEMPOTENCY_KEY}`;
const IDEMPOTENCY_ROW_ID = '00000000-0000-0000-0000-0000000000bb';

describe('SocialTransfersService.sendGift (GIFT_COMMANDS port)', () => {
  it('returns { ok: false, reason: "disabled" } when the command row is missing', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[]] } });
    const result = await svc.sendGift(
      { amount: '10', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });

  it('returns { ok: false, reason: "disabled" } when the command is disabled', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[DISABLED_ROW]] } });
    const result = await svc.sendGift(
      { amount: '10', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });

  it('returns { ok: false, reason: "player_not_found" } when the sender is missing', async () => {
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: vi.fn().mockResolvedValue([]),
    });
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW]] },
      directory,
    });
    const result = await svc.sendGift(
      { amount: '10', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'player_not_found', playerId: ACTOR_ID });
  });

  it('returns { ok: false, reason: "insufficient_balance" } when the wallet debit fails', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[ENABLED_ROW]],
        returning: [[{ id: IDEMPOTENCY_ROW_ID }]],
      },
      wallet: makeWallet(false),
    });
    const result = await svc.sendGift(
      { amount: '10', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'insufficient_balance' });
  });

  it('posts a system message with gift metadata and returns { ok: true } on success', async () => {
    const writer = makeWriter();
    const svc = makeSvc({
      drizzleRows: {
        select: [[ENABLED_ROW]],
        returning: [[{ ...GIFT_ROW }]],
      },
      writer,
    });
    const result = await svc.sendGift(
      { amount: '10.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(writer.postSystemMessage).toHaveBeenCalledOnce();
    expect(writer.postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ACTOR_ID,
        metadata: expect.objectContaining({
          command: 'gift',
          giftId: GIFT_ID,
          senderId: ACTOR_ID,
          senderUsername: 'bob',
        }),
      }),
    );
    expect(result).toEqual({ ok: true, message: SYSTEM_MSG });
  });

  it('returns { ok: false, reason: "below_minimum" } when amount is under config minAmount', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[{ ...ENABLED_ROW, config: { minAmount: '5.00000000' } }]] },
    });
    const result = await svc.sendGift(
      { amount: '1.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'below_minimum' });
  });
});

describe('SocialTransfersService.sendGift idempotency', () => {
  it('inserts the idempotency guard row and debits once when a fresh key is supplied', async () => {
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: {
        select: [[ENABLED_ROW], []],
        returning: [[{ id: IDEMPOTENCY_ROW_ID }], [{ ...GIFT_ROW }]],
      },
      wallet,
    });
    const result = await svc.sendGift(
      { amount: '10.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(wallet.debit).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, message: SYSTEM_MSG });
  });

  it('replays the stored result without debiting the wallet again', async () => {
    const wallet = makeWallet();
    const giftInput = {
      type: 'gift' as const,
      amount: '10.00000000',
      roomId: ROOM_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    };
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW]] },
      cache: makeCache({
        [IDEMPOTENCY_CACHE_KEY]: { fingerprint: fingerprintCommand(giftInput), result: SYSTEM_MSG },
      }),
      wallet,
    });
    const result = await svc.sendGift(
      { amount: '10.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, message: SYSTEM_MSG });
  });

  it('returns { ok: false, reason: "idempotency_key_reuse" } when the same key is reused with a different amount', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW]] },
      cache: makeCache({
        [IDEMPOTENCY_CACHE_KEY]: {
          fingerprint: fingerprintCommand({
            type: 'gift',
            amount: '5.00000000',
            roomId: ROOM_ID,
            idempotencyKey: IDEMPOTENCY_KEY,
          }),
          result: SYSTEM_MSG,
        },
      }),
    });
    const result = await svc.sendGift(
      { amount: '10.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'idempotency_key_reuse' });
  });

  it('returns { ok: false, reason: "idempotency_key_reuse" } when the same key+amount is reused for a different room', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW]] },
      cache: makeCache({
        [IDEMPOTENCY_CACHE_KEY]: {
          fingerprint: fingerprintCommand({
            type: 'gift',
            amount: '10.00000000',
            roomId: OTHER_ROOM_ID,
            idempotencyKey: IDEMPOTENCY_KEY,
          }),
          result: SYSTEM_MSG,
        },
      }),
    });
    const result = await svc.sendGift(
      { amount: '10.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'idempotency_key_reuse' });
  });
});

describe('SocialTransfersService.claimGift', () => {
  it('credits the claimer and returns { ok: true } on happy path', async () => {
    const wallet = makeWallet();
    const writer = makeWriter();
    const svc = makeSvc({
      drizzleRows: {
        select: [[GIFT_ROW]],
        returning: [
          [
            {
              ...GIFT_ROW,
              claimedBy: CLAIMER_ID,
              claimedByUsername: 'alice',
              claimedAt: new Date(),
            },
          ],
        ],
      },
      wallet,
      writer,
    });
    const result = await svc.claimGift(GIFT_ID, CLAIMER_ID);
    expect(wallet.credit).toHaveBeenCalledOnce();
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: CLAIMER_ID, type: 'gift' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claimedBy).toBe(CLAIMER_ID);
      expect(result.claimedByUsername).toBe('alice');
      expect(result.claimedAt).toEqual(expect.any(String));
    }
    expect(writer.updateSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: MSG_ID,
        metadata: expect.objectContaining({
          command: 'gift',
          status: 'claimed',
          claimedBy: CLAIMER_ID,
          claimedByUsername: 'alice',
        }),
      }),
    );
  });

  it('returns { ok: false, reason: "self_claim" } when the sender tries to claim their own gift', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[GIFT_ROW]], returning: [] }, // senderId === ACTOR_ID
    });
    const result = await svc.claimGift(GIFT_ID, ACTOR_ID);
    expect(result).toEqual({ ok: false, reason: 'self_claim' });
  });

  it('returns { ok: false, reason: "already_claimed" } when the update returns no rows (race lost)', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[GIFT_ROW]], returning: [[]] }, // empty = already claimed
    });
    const result = await svc.claimGift(GIFT_ID, CLAIMER_ID);
    expect(result).toEqual({ ok: false, reason: 'already_claimed' });
  });

  it('returns { ok: false, reason: "gift_not_found" } when the gift does not exist', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[]], returning: [] }, // no gift row
    });
    const result = await svc.claimGift(GIFT_ID, CLAIMER_ID);
    expect(result).toEqual({ ok: false, reason: 'gift_not_found' });
  });

  it('returns { ok: false, reason: "room_not_member", roomId: <the gift\'s room> } when the claimer is not a room member', async () => {
    const notMember = Object.assign(new Error('not a member'), { name: 'ChatRoomNotMemberError' });
    const roomAccess = mock<ChatRoomAccess>({
      verifyRoomAccess: vi.fn().mockRejectedValue(notMember),
    });
    const svc = makeSvc({
      drizzleRows: { select: [[GIFT_ROW]], returning: [] },
      roomAccess,
    });
    const result = await svc.claimGift(GIFT_ID, CLAIMER_ID);
    expect(result).toEqual({ ok: false, reason: 'room_not_member', roomId: GIFT_ROW.roomId });
  });
});

describe('SocialTransfersService.getGift', () => {
  it('returns { ok: true, gift } for a gift in a room the viewer is a member of', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[GIFT_ROW]] } });
    const result = await svc.getGift(GIFT_ID, CLAIMER_ID);
    expect(result).toEqual({
      ok: true,
      gift: {
        id: GIFT_ROW.id,
        senderId: GIFT_ROW.senderId,
        senderUsername: GIFT_ROW.senderUsername,
        amount: GIFT_ROW.amount,
        currency: GIFT_ROW.currency,
        claimedBy: null,
        claimedByUsername: null,
        claimedAt: null,
        createdAt: GIFT_ROW.createdAt.toISOString(),
      },
    });
  });

  it('returns { ok: false, reason: "gift_not_found" } when the gift does not exist', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[]] } });
    const result = await svc.getGift(GIFT_ID, CLAIMER_ID);
    expect(result).toEqual({ ok: false, reason: 'gift_not_found' });
  });

  it('returns { ok: false, reason: "room_not_member", roomId: <the gift\'s room> } when the viewer is not a room member', async () => {
    const notMember = Object.assign(new Error('not a member'), { name: 'ChatRoomNotMemberError' });
    const roomAccess = mock<ChatRoomAccess>({
      verifyRoomAccess: vi.fn().mockRejectedValue(notMember),
    });
    const svc = makeSvc({
      drizzleRows: { select: [[GIFT_ROW]] },
      roomAccess,
    });
    const result = await svc.getGift(GIFT_ID, CLAIMER_ID);
    expect(result).toEqual({ ok: false, reason: 'room_not_member', roomId: GIFT_ROW.roomId });
  });
});

describe('SocialTransfersService.sendRain (RAIN_COMMANDS port)', () => {
  const RAIN_ROW = { ...ENABLED_ROW, key: 'rain', label: 'Rain' };

  it('returns { ok: false, reason: "player_not_found" } when a recipient is missing', async () => {
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: vi
        .fn()
        .mockImplementation((ids: string[]) =>
          Promise.resolve(ids.includes(ACTOR_ID) ? [{ userId: ACTOR_ID, username: 'bob' }] : []),
        ),
    });
    const svc = makeSvc({
      drizzleRows: { select: [[RAIN_ROW]] },
      directory,
    });
    const result = await svc.sendRain(
      {
        amount: '10.00000000',
        recipientCount: 1,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [CLAIMER_ID],
      },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'player_not_found', playerId: CLAIMER_ID });
  });

  it('returns { ok: false, reason: "no_online_users" } when onlineUserIds only contains the actor', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[RAIN_ROW]] } });
    const result = await svc.sendRain(
      {
        amount: '10.00000000',
        recipientCount: 5,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [ACTOR_ID],
      },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'no_online_users' });
  });

  it('replays the stored result without debiting the wallet again', async () => {
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: { select: [[RAIN_ROW]] },
      cache: makeCache({
        [RAIN_IDEMPOTENCY_CACHE_KEY]: {
          fingerprint: fingerprintCommand({
            type: 'rain',
            amount: '10.99000000',
            recipientCount: 10,
            roomId: ROOM_ID,
            idempotencyKey: IDEMPOTENCY_KEY,
          }),
          result: SYSTEM_MSG,
        },
      }),
      wallet,
    });

    const result = await svc.sendRain(
      {
        amount: '10.99000000',
        recipientCount: 10,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [],
      },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: true, message: SYSTEM_MSG });
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('distributes to online recipients excluding the actor, persists a player_rain row + receivers, posts a system message with rain metadata inside the transaction, and publishes after commit', async () => {
    const wallet = makeWallet();
    const writer = makeWriter();
    const transport = makeTransport();
    const svc = makeSvc({
      drizzleRows: {
        select: [[RAIN_ROW]],
        returning: [[{ id: '00000000-0000-0000-0000-0000000000cc' }]],
        execute: [[{ per_recipient: '5.00000000', total_distributed: '10.00000000' }]],
      },
      wallet,
      writer,
      transport,
    });
    const result = await svc.sendRain(
      {
        amount: '10.00000000',
        recipientCount: 2,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [ACTOR_ID, CLAIMER_ID, RECIPIENT_2],
      },
      ACTOR_ID,
    );
    expect(result.ok).toBe(true);
    expect(wallet.credit).toHaveBeenCalledTimes(2);
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: CLAIMER_ID,
      amount: '5.00000000',
      currency: 'USD',
      type: 'rain',
    });
    expect(writer.postSystemMessage).toHaveBeenCalledOnce();
    expect(writer.postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: ROOM_ID,
        actorId: ACTOR_ID,
        metadata: expect.objectContaining({
          command: 'rain',
          fromUserId: ACTOR_ID,
          fromUsername: 'bob',
          amount: '10.00000000',
          currency: 'USD',
          recipientCount: 2,
          perRecipient: '5.00000000',
          recipients: expect.arrayContaining([
            { userId: CLAIMER_ID, username: 'alice' },
            { userId: RECIPIENT_2, username: 'charlie' },
          ]),
        }),
      }),
    );
    expect(transport.publish).toHaveBeenCalledWith(`chat:room:${ROOM_ID}`, SYSTEM_MSG);
  });

  it('debits only the amount actually distributed (floor(amount/n)*n), never the raw player-typed amount', async () => {
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: {
        select: [[RAIN_ROW]],
        returning: [[{ id: '00000000-0000-0000-0000-0000000000cc' }]],
        execute: [[{ per_recipient: '1.00000000', total_distributed: '10.00000000' }]],
      },
      wallet,
      directory: makeDirectory(
        'bob',
        'alice',
        Array.from({ length: 10 }, (_, i) => `00000000-0000-0000-0000-0000000000${10 + i}`),
      ),
    });
    await svc.sendRain(
      {
        amount: '10.99000000',
        recipientCount: 10,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: Array.from(
          { length: 10 },
          (_, i) => `00000000-0000-0000-0000-0000000000${10 + i}`,
        ),
      },
      ACTOR_ID,
    );
    expect(wallet.debit).toHaveBeenCalledWith(expect.anything(), {
      userId: ACTOR_ID,
      amount: '10.00000000',
      type: 'rain',
    });
  });

  it('returns { ok: false, reason: "below_minimum" } when amount is below config minAmount', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[{ ...RAIN_ROW, config: { minAmount: '5.00000000' } }]] },
    });
    const result = await svc.sendRain(
      {
        amount: '1.00000000',
        recipientCount: 1,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [],
      },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'below_minimum' });
  });

  it('returns { ok: false, reason: "exceeds_limit" } when amount is above config maxAmount', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[{ ...RAIN_ROW, config: { maxAmount: '10.00000000' } }]] },
    });
    const result = await svc.sendRain(
      {
        amount: '50.00000000',
        recipientCount: 1,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [],
      },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'exceeds_limit' });
  });

  it('returns { ok: false, reason: "exceeds_limit" } when recipientCount exceeds config maxRecipients', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[{ ...RAIN_ROW, config: { maxRecipients: 10 } }]] },
    });
    const result = await svc.sendRain(
      {
        amount: '100.00000000',
        recipientCount: 11,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [],
      },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'exceeds_limit' });
  });

  it('returns { ok: false, reason: "too_many_recipients" } when recipientCount exceeds the whole-dollar amount', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[RAIN_ROW]] } });
    const result = await svc.sendRain(
      {
        amount: '3.00000000',
        recipientCount: 4,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [],
      },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'too_many_recipients' });
  });
});

const DONATE_ROW = {
  key: 'donate',
  enabled: true,
  label: 'Donate',
  description: 'Send a direct tip to a specific player',
  config: null,
  updatedAt: new Date(),
};

const DONATE_SYSTEM_MSG: CommandChatMessage = {
  id: MSG_ID,
  roomId: ROOM_ID,
  actorId: ACTOR_ID,
  userId: ACTOR_ID,
  username: 'system',
  content: '',
  type: 'system',
  isDeleted: false,
  metadata: {
    command: 'donate',
    senderId: ACTOR_ID,
    senderUsername: 'bob',
    recipientId: CLAIMER_ID,
    recipientUsername: 'alice',
    amount: '10.00000000',
    currency: 'USD',
  },
  createdAt: new Date().toISOString(),
};

/**
 * Directory mock where findPlayerIds resolves the RECIPIENT (CLAIMER_ID = 'alice').
 * Used for donate tests that target 'alice' - the default makeDirectory() always
 * returns ACTOR_ID which only has username 'bob', so alice is never found.
 */
function makeRecipientDirectory(): AdminUserDirectory {
  const all = [
    {
      userId: ACTOR_ID,
      username: 'bob',
      email: 'bob@example.com',
      kycStatus: null,
      language: null,
      avatarUrl: null,
      createdAt: DIRECTORY_CREATED_AT,
      level: 3,
      currency: 'USD',
    },
    {
      userId: CLAIMER_ID,
      username: 'alice',
      email: 'alice@example.com',
      kycStatus: null,
      language: null,
      avatarUrl: null,
      createdAt: DIRECTORY_CREATED_AT,
      level: 1,
      currency: 'USD',
    },
  ];
  return mock<AdminUserDirectory>({
    findPlayerIds: vi.fn().mockResolvedValue([CLAIMER_ID]),
    lookupPlayers: vi.fn().mockImplementation((ids: string[]) => {
      return Promise.resolve(all.filter((p) => ids.includes(p.userId)));
    }),
    getPlayerByUsername: vi.fn().mockImplementation((username: string) => {
      return Promise.resolve(
        all.find((p) => p.username.toLowerCase() === username.toLowerCase()) ?? null,
      );
    }),
  });
}

describe('SocialTransfersService.sendDonate', () => {
  it('debits sender, credits recipient, and returns the system message on success', async () => {
    const wallet = makeWallet();
    const writer = mock<ChatSystemWriter>({
      postSystemMessage: vi.fn().mockResolvedValue(DONATE_SYSTEM_MSG),
    });
    const svc = makeSvc({
      drizzleRows: {
        select: [[DONATE_ROW]],
        returning: [[{ id: '00000000-0000-0000-0000-0000000000dd' }]],
      },
      wallet,
      writer,
      directory: makeRecipientDirectory(),
    });
    const result = await svc.sendDonate(
      {
        targetUsername: 'alice',
        amount: '10.00000000',
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      ACTOR_ID,
    );
    expect(wallet.debit).toHaveBeenCalledWith(expect.anything(), {
      userId: ACTOR_ID,
      amount: '10.00000000',
      type: 'tip',
    });
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: CLAIMER_ID,
      amount: '10.00000000',
      currency: 'USD',
      type: 'tip',
    });
    expect(result.id).toBe(MSG_ID);
  });

  it('throws DonateSelfError when the sender targets themselves', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[DONATE_ROW]] } });
    await expect(
      svc.sendDonate(
        {
          targetUsername: 'bob',
          amount: '10.00000000',
          roomId: ROOM_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        ACTOR_ID,
      ),
    ).rejects.toThrow(DonateSelfError);
  });

  it('throws ChatPlayerNotFoundError when the target username does not exist', async () => {
    const directory = mock<AdminUserDirectory>({
      findPlayerIds: vi.fn().mockResolvedValue([]),
      lookupPlayers: vi.fn().mockResolvedValue([]),
      getPlayerByUsername: vi.fn().mockResolvedValue(null),
    });
    const svc = makeSvc({ drizzleRows: { select: [[DONATE_ROW]] }, directory });
    await expect(
      svc.sendDonate(
        {
          targetUsername: 'ghost',
          amount: '10.00000000',
          roomId: ROOM_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        ACTOR_ID,
      ),
    ).rejects.toThrow(ChatPlayerNotFoundError);
  });

  it('throws InsufficientBalanceError when the sender wallet debit fails', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[DONATE_ROW]], returning: [[{ id: IDEMPOTENCY_ROW_ID }]] },
      wallet: makeWallet(false),
      directory: makeRecipientDirectory(),
    });
    await expect(
      svc.sendDonate(
        {
          targetUsername: 'alice',
          amount: '10.00000000',
          roomId: ROOM_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        ACTOR_ID,
      ),
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it('throws BelowMinimumError when amount is below config minAmount', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[{ ...DONATE_ROW, config: { minAmount: '5.00000000' } }]] },
    });
    await expect(
      svc.sendDonate(
        {
          targetUsername: 'alice',
          amount: '1.00000000',
          roomId: ROOM_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        ACTOR_ID,
      ),
    ).rejects.toThrow(BelowMinimumError);
  });
});

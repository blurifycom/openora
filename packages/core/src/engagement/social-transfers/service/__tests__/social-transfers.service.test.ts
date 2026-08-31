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
  ChatBlockWriter,
} from '@openora/core/contracts';
import {
  SocialTransfersService,
  InsufficientBalanceError,
  BelowMinimumError,
  DonateSelfError,
  BlockedRecipientError,
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
const ACTOR_PLAYER_ID = '00000000-0000-0000-0000-000000000101';
const CLAIMER_PLAYER_ID = '00000000-0000-0000-0000-000000000102';
const RECIPIENT_2_PLAYER_ID = '00000000-0000-0000-0000-000000000106';

function makeDirectory(
  senderUsername = 'bob',
  claimerUsername = 'alice',
  extraUserIds: string[] = [],
): AdminUserDirectory {
  const all = [
    {
      playerId: ACTOR_PLAYER_ID,
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
      playerId: CLAIMER_PLAYER_ID,
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
      playerId: RECIPIENT_2_PLAYER_ID,
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
      playerId: `00000000-0000-0000-0000-0000001${String(index).padStart(5, '0')}`,
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

function makeBlockWriter(blocked = false): ChatBlockWriter {
  return mock<ChatBlockWriter>({
    isBlocked: vi.fn().mockResolvedValue(blocked),
  });
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
    blockWriter?: ChatBlockWriter;
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
    overrides.blockWriter ?? makeBlockWriter(),
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

  // Naming a currency the sender does not hold is not a distinct failure mode - it is the
  // SAME insufficient-balance path an over-spend takes, because WALLET_COMMANDS.debit finds
  // no balance row for a currency the player has never held (available: '0') exactly as it
  // would for an over-spend in a currency they do hold.
  it('returns { ok: false, reason: "insufficient_balance" } when the sender does not hold the requested currency', async () => {
    const wallet = mock<WalletCommands>({
      debit: vi.fn().mockResolvedValue({ ok: false, available: '0' }),
      credit: vi.fn(),
    });
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW]] },
      wallet,
    });
    const result = await svc.sendGift(
      { amount: '10.00000000', currency: 'BTC', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(wallet.debit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currency: 'BTC' }),
    );
    expect(result).toEqual({ ok: false, reason: 'insufficient_balance' });
  });

  it('debits the sender-chosen currency and credits the gift row in that same currency', async () => {
    const wallet = mock<WalletCommands>({
      debit: vi.fn().mockResolvedValue({ ok: true, newBalance: '1.00000000', currency: 'BTC' }),
      credit: vi.fn(),
    });
    const svc = makeSvc({
      drizzleRows: {
        select: [[ENABLED_ROW]],
        returning: [[{ ...GIFT_ROW, currency: 'BTC' }]],
      },
      wallet,
    });
    await svc.sendGift(
      { amount: '0.00100000', currency: 'BTC', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(wallet.debit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: '0.00100000', currency: 'BTC' }),
    );
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
      drizzleRows: {
        select: [[{ ...ENABLED_ROW, config: { minAmount: { USD: '5.00000000' } } }]],
      },
    });
    const result = await svc.sendGift(
      { amount: '1.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'below_minimum' });
  });

  // A row written before CommandConfigSchema's minAmount/maxAmount became per-currency maps
  // (a flat `{ minAmount: '5.00000000' }`, not `{ minAmount: { USD: '5.00000000' } }`) must
  // not silently disable the limit AND still succeed as if nothing were configured wrong -
  // it should be treated as unconfigured (logged, not thrown), not crash the whole command.
  it('treats a legacy flat-shaped config (pre-per-currency) as unconfigured rather than enforcing it wrong', async () => {
    const svc = makeSvc({
      drizzleRows: {
        // Old shape: minAmount was a bare string, not a Record<currency, MoneyAmount>.
        select: [[{ ...ENABLED_ROW, config: { minAmount: '5.00000000' } }]],
        returning: [[{ ...GIFT_ROW }]],
      },
    });
    const result = await svc.sendGift(
      { amount: '1.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: true, message: SYSTEM_MSG });
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
      expect.objectContaining({ userId: CLAIMER_ID, type: 'gift', allowNewCurrency: true }),
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

  // The gift's OWN stored currency is credited, never the claimer's active one -
  // `allowNewCurrency: true` is what lets a claimer who has never held that currency
  // still receive it (opens the balance row instead of failing 'currency mismatch').
  it("credits a claimer who has never held the gift's currency, in that currency", async () => {
    const wallet = mock<WalletCommands>({
      credit: vi.fn().mockResolvedValue({ ok: true, newBalance: '0.00100000' }),
    });
    const svc = makeSvc({
      drizzleRows: {
        select: [[{ ...GIFT_ROW, currency: 'BTC', amount: '0.00100000' }]],
        returning: [
          [
            {
              ...GIFT_ROW,
              currency: 'BTC',
              amount: '0.00100000',
              claimedBy: CLAIMER_ID,
              claimedByUsername: 'alice',
              claimedAt: new Date(),
            },
          ],
        ],
      },
      wallet,
    });
    const result = await svc.claimGift(GIFT_ID, CLAIMER_ID);
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: CLAIMER_ID,
      amount: '0.00100000',
      currency: 'BTC',
      type: 'gift',
      allowNewCurrency: true,
      allowNewWallet: true,
    });
    expect(result.ok).toBe(true);
  });

  it('returns { ok: false, reason: "self_claim" } when the sender tries to claim their own gift', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[GIFT_ROW]], returning: [] }, // senderId === ACTOR_ID
    });
    const result = await svc.claimGift(GIFT_ID, ACTOR_ID);
    expect(result).toEqual({ ok: false, reason: 'self_claim' });
  });

  it('returns { ok: false, reason: "blocked_recipient" } when the sender blocked the claimer', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[GIFT_ROW]], returning: [] },
      blockWriter: mock<ChatBlockWriter>({
        getBlockedUserIds: vi.fn().mockResolvedValue([CLAIMER_ID]),
        isBlocked: vi.fn().mockResolvedValue(true),
      }),
    });
    const result = await svc.claimGift(GIFT_ID, CLAIMER_ID);
    expect(result).toEqual({ ok: false, reason: 'blocked_recipient' });
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

  it('debits the sender-chosen currency and credits every recipient in that same currency', async () => {
    const wallet = mock<WalletCommands>({
      debit: vi.fn().mockResolvedValue({ ok: true, newBalance: '1.00000000', currency: 'BTC' }),
      credit: vi.fn().mockResolvedValue({ ok: true, newBalance: '0.00050000' }),
    });
    const svc = makeSvc({
      drizzleRows: {
        select: [[RAIN_ROW]],
        returning: [[{ id: '00000000-0000-0000-0000-0000000000cc' }]],
        execute: [
          [
            {
              per_recipient_units: '500000000000000',
              total_distributed_units: '1000000000000000',
              has_positive_recipient: true,
            },
          ],
        ],
      },
      wallet,
    });
    await svc.sendRain(
      {
        amount: '0.00100000',
        currency: 'BTC',
        recipientCount: 2,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [ACTOR_ID, CLAIMER_ID, RECIPIENT_2],
      },
      ACTOR_ID,
    );
    expect(wallet.debit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currency: 'BTC' }),
    );
    expect(wallet.credit).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(wallet.credit).mock.calls) {
      expect(call[1]).toMatchObject({ currency: 'BTC', allowNewCurrency: true });
    }
  });

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
        execute: [
          [
            {
              per_recipient_units: '5000000000000000000',
              total_distributed_units: '10000000000000000000',
              has_positive_recipient: true,
            },
          ],
        ],
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
      amount: '5.000000000000000000',
      currency: 'USD',
      type: 'rain',
      allowNewCurrency: true,
      allowNewWallet: true,
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
          amount: '10.000000000000000000',
          currency: 'USD',
          recipientCount: 2,
          perRecipient: '5.000000000000000000',
          recipients: expect.arrayContaining([
            { userId: CLAIMER_ID, username: 'alice' },
            { userId: RECIPIENT_2, username: 'charlie' },
          ]),
        }),
      }),
    );
    expect(transport.publish).toHaveBeenCalledWith(`chat:room:${ROOM_ID}`, SYSTEM_MSG);
  });

  it('debits only the amount actually distributed after flooring per-recipient cents', async () => {
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: {
        select: [[RAIN_ROW]],
        returning: [[{ id: '00000000-0000-0000-0000-0000000000cc' }]],
        execute: [
          [
            {
              per_recipient_units: '1090000000000000000',
              total_distributed_units: '10900000000000000000',
              has_positive_recipient: true,
            },
          ],
        ],
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
      amount: '10.900000000000000000',
      type: 'rain',
    });
  });

  it('fixes the per-recipient amount from the requested count before reducing to available users', async () => {
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: {
        select: [[RAIN_ROW]],
        returning: [[{ id: '00000000-0000-0000-0000-0000000000cc' }]],
        execute: [
          [
            {
              per_recipient_units: '20000000000000000000',
              total_distributed_units: '80000000000000000000',
              has_positive_recipient: true,
            },
          ],
        ],
      },
      wallet,
      directory: makeDirectory('bob', 'alice', [
        '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000011',
      ]),
    });

    await svc.sendRain(
      {
        amount: '100.00000000',
        recipientCount: 5,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [
          CLAIMER_ID,
          RECIPIENT_2,
          '00000000-0000-0000-0000-000000000010',
          '00000000-0000-0000-0000-000000000011',
        ],
      },
      ACTOR_ID,
    );

    expect(wallet.credit).toHaveBeenCalledTimes(4);
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: CLAIMER_ID,
      amount: '20.000000000000000000',
      currency: 'USD',
      type: 'rain',
      allowNewCurrency: true,
      allowNewWallet: true,
    });
    expect(wallet.debit).toHaveBeenCalledWith(expect.anything(), {
      userId: ACTOR_ID,
      amount: '80.000000000000000000',
      type: 'rain',
    });
  });

  it('allows blocked users to receive rain', async () => {
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: {
        select: [[RAIN_ROW]],
        returning: [[{ id: '00000000-0000-0000-0000-0000000000cc' }]],
        execute: [
          [
            {
              per_recipient_units: '5000000000000000000',
              total_distributed_units: '10000000000000000000',
              has_positive_recipient: true,
            },
          ],
        ],
      },
      wallet,
      blockWriter: mock<ChatBlockWriter>({
        getBlockedUserIds: vi.fn().mockResolvedValue([CLAIMER_ID]),
        isBlocked: vi.fn().mockResolvedValue(true),
      }),
    });

    await svc.sendRain(
      {
        amount: '10.00000000',
        recipientCount: 2,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [ACTOR_ID, CLAIMER_ID, RECIPIENT_2],
      },
      ACTOR_ID,
    );

    expect(wallet.credit).toHaveBeenCalledTimes(2);
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: CLAIMER_ID,
      amount: '5.000000000000000000',
      currency: 'USD',
      type: 'rain',
      allowNewCurrency: true,
      allowNewWallet: true,
    });
  });

  it('supports non-even totals by flooring the requested per-recipient payout to cents', async () => {
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: {
        select: [[RAIN_ROW]],
        returning: [[{ id: '00000000-0000-0000-0000-0000000000cc' }]],
        execute: [
          [
            {
              per_recipient_units: '14810000000000000000',
              total_distributed_units: '44430000000000000000',
              has_positive_recipient: true,
            },
          ],
        ],
      },
      wallet,
      directory: makeDirectory('bob', 'alice', ['00000000-0000-0000-0000-000000000010']),
    });

    await svc.sendRain(
      {
        amount: '44.44000000',
        recipientCount: 3,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [ACTOR_ID, CLAIMER_ID, RECIPIENT_2, '00000000-0000-0000-0000-000000000010'],
      },
      ACTOR_ID,
    );

    expect(wallet.credit).toHaveBeenCalledTimes(3);
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: CLAIMER_ID,
      amount: '14.810000000000000000',
      currency: 'USD',
      type: 'rain',
      allowNewCurrency: true,
      allowNewWallet: true,
    });
    expect(wallet.debit).toHaveBeenCalledWith(expect.anything(), {
      userId: ACTOR_ID,
      amount: '44.430000000000000000',
      type: 'rain',
    });
  });

  // Below-minimum/exceeds-limit are keyed by currency now, so the check only runs once
  // the ACTUAL debited currency is known - after `wallet.debit`, inside the transaction
  // (see assertWithinCommandLimits). That needs at least one resolvable recipient to
  // reach the transaction at all, unlike the old currency-blind, pre-transaction check.
  it('returns { ok: false, reason: "below_minimum" } when amount is below config minAmount', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[{ ...RAIN_ROW, config: { minAmount: { USD: '5.00000000' } } }]],
        execute: [
          [
            {
              per_recipient_units: '1000000000000000000',
              total_distributed_units: '1000000000000000000',
              has_positive_recipient: true,
            },
          ],
        ],
      },
    });
    const result = await svc.sendRain(
      {
        amount: '1.00000000',
        recipientCount: 1,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [CLAIMER_ID],
      },
      ACTOR_ID,
    );
    expect(result).toEqual({ ok: false, reason: 'below_minimum' });
  });

  it('returns { ok: false, reason: "exceeds_limit" } when amount is above config maxAmount', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[{ ...RAIN_ROW, config: { maxAmount: { USD: '10.00000000' } } }]],
        execute: [
          [
            {
              per_recipient_units: '50000000000000000000',
              total_distributed_units: '50000000000000000000',
              has_positive_recipient: true,
            },
          ],
        ],
      },
    });
    const result = await svc.sendRain(
      {
        amount: '50.00000000',
        recipientCount: 1,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [CLAIMER_ID],
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
      playerId: ACTOR_PLAYER_ID,
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
      playerId: CLAIMER_PLAYER_ID,
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
      allowNewCurrency: true,
      allowNewWallet: true,
    });
    expect(writer.postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ACTOR_ID,
        metadata: expect.objectContaining({
          command: 'donate',
          senderId: ACTOR_ID,
          senderUsername: 'bob',
          recipientId: CLAIMER_ID,
          recipientUsername: 'alice',
        }),
      }),
    );
    expect(result.id).toBe(MSG_ID);
  });

  it('debits and credits the sender-chosen currency, not the active one', async () => {
    const wallet = mock<WalletCommands>({
      debit: vi.fn().mockResolvedValue({ ok: true, newBalance: '1.00000000', currency: 'BTC' }),
      credit: vi.fn().mockResolvedValue({ ok: true, newBalance: '0.00100000' }),
    });
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
    await svc.sendDonate(
      {
        targetUsername: 'alice',
        amount: '0.00100000',
        currency: 'BTC',
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      ACTOR_ID,
    );
    expect(wallet.debit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: '0.00100000', currency: 'BTC' }),
    );
    // The recipient is credited in the SAME currency the sender was debited in - never
    // routed through an exchange rate - with allowNewCurrency so a recipient who has
    // never held BTC still receives it.
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: CLAIMER_ID,
      amount: '0.00100000',
      currency: 'BTC',
      type: 'tip',
      allowNewCurrency: true,
      allowNewWallet: true,
    });
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

  it('throws BlockedRecipientError when the sender targets a blocked user', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[DONATE_ROW]] },
      directory: makeRecipientDirectory(),
      blockWriter: mock<ChatBlockWriter>({
        getBlockedUserIds: vi.fn().mockResolvedValue([CLAIMER_ID]),
        isBlocked: vi.fn().mockResolvedValue(true),
      }),
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
    ).rejects.toThrow(BlockedRecipientError);
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
      drizzleRows: {
        select: [[{ ...DONATE_ROW, config: { minAmount: { USD: '5.00000000' } } }]],
      },
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

describe('fingerprintCommand currency-awareness', () => {
  // A replayed idempotency key must never let a caller quietly swap which balance a gift/
  // rain/donate debits by resubmitting the same amount/room/target under a different
  // currency - the fingerprint has to treat that as a distinct request.
  it('produces a different fingerprint for the same gift request in a different currency', () => {
    const base = {
      type: 'gift' as const,
      amount: '10.00000000',
      roomId: ROOM_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    };
    const usd = fingerprintCommand({ ...base, currency: 'USD' });
    const btc = fingerprintCommand({ ...base, currency: 'BTC' });
    const omitted = fingerprintCommand(base);
    expect(usd).not.toBe(btc);
    expect(usd).not.toBe(omitted);
  });
});

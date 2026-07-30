import { describe, it, expect, vi } from 'vitest';
import { mock, makeDrizzle, makeEventBus } from '../../../../testing/mock.js';
import type {
  ChatSystemMessage,
  ChatSystemWriter,
  ChatBlockWriter,
  WalletCommands,
  AdminUserDirectory,
  AdminGameReporting,
  AuditWritePort,
  RealtimeTransport,
} from '@openora/core/contracts';
import {
  ChatCommandsService,
  CommandDisabledError,
  InsufficientBalanceError,
  BelowMinimumError,
  NoOnlineUsersError,
  ExceedsLimitError,
  GiftNotFoundError,
  GiftAlreadyClaimedError,
  GiftSelfClaimError,
  DonateSelfError,
  ChatPlayerNotFoundError,
  TooManyRecipientsError,
  SelfModerationActionError,
} from '../chat-commands.service.js';

const ACTOR_ID = '00000000-0000-0000-0000-000000000001';
const CLAIMER_ID = '00000000-0000-0000-0000-000000000002';
const ROOM_ID = '00000000-0000-0000-0000-000000000003';
const MSG_ID = '00000000-0000-0000-0000-000000000004';
const GIFT_ID = '00000000-0000-0000-0000-000000000005';

const ENABLED_ROW = {
  key: 'gift',
  enabled: true,
  label: 'Gift',
  description: null,
  config: null,
  updatedAt: new Date(),
};

const DISABLED_ROW = { ...ENABLED_ROW, enabled: false };

const SYSTEM_MSG: ChatSystemMessage = {
  id: MSG_ID,
  roomId: ROOM_ID,
  actorId: ACTOR_ID,
  content: '',
  metadata: {
    command: 'gift',
    giftId: GIFT_ID,
    senderId: ACTOR_ID,
    senderUsername: 'bob',
    amount: '10.00000000',
    currency: 'USD',
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

function makeDirectory(senderUsername = 'bob', claimerUsername = 'alice'): AdminUserDirectory {
  return mock<AdminUserDirectory>({
    findPlayerIds: vi.fn().mockResolvedValue([ACTOR_ID]),
    lookupPlayers: vi.fn().mockImplementation((ids: string[]) => {
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
      ];
      return Promise.resolve(all.filter((p) => ids.includes(p.userId)));
    }),
  });
}

function makeAudit(): AuditWritePort {
  return mock<AuditWritePort>({ record: vi.fn().mockResolvedValue(undefined) });
}

function makeBlockWriter(): ChatBlockWriter {
  return mock<ChatBlockWriter>({
    blockUser: vi.fn().mockResolvedValue(undefined),
    ignoreUser: vi.fn().mockResolvedValue(undefined),
    getExcludedUserIds: vi.fn().mockResolvedValue([]),
  });
}

function makeGameReporting(): AdminGameReporting {
  return mock<AdminGameReporting>({
    getPlayerStats: vi.fn().mockResolvedValue({ totalWagered: '100.00000000', totalBets: 5 }),
  });
}

function makeTransport(onlineIds: string[] = [CLAIMER_ID]): RealtimeTransport {
  return mock<RealtimeTransport>({
    getOnlineUserIds: vi.fn().mockResolvedValue(onlineIds),
    publish: vi.fn().mockResolvedValue(undefined),
  });
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
    gameReporting?: AdminGameReporting;
    blockWriter?: ChatBlockWriter;
  } = {},
) {
  const drizzle = makeDrizzle({
    select: overrides.drizzleRows?.select ?? [],
    returning: overrides.drizzleRows?.returning ?? [],
    execute: overrides.drizzleRows?.execute,
  });
  return new ChatCommandsService(
    drizzle,
    overrides.writer ?? makeWriter(),
    overrides.wallet ?? makeWallet(),
    overrides.directory ?? makeDirectory(),
    overrides.audit ?? makeAudit(),
    overrides.transport ?? makeTransport(),
    mock(makeEventBus()),
    overrides.blockWriter ?? makeBlockWriter(),
    overrides.gameReporting ?? makeGameReporting(),
  );
}

describe('ChatCommandsService.listCommands', () => {
  it('returns only enabled commands by default', async () => {
    // mock simulates DB returning only enabled rows (WHERE enabled = true applied at SQL level)
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW]] },
    });
    const result = await svc.listCommands();
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe('gift');
  });

  it('returns all commands when includeDisabled is true', async () => {
    // mock simulates DB returning all rows (no WHERE clause)
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW, DISABLED_ROW]] },
    });
    const result = await svc.listCommands(true);
    expect(result).toHaveLength(2);
  });
});

describe('ChatCommandsService.searchMentions', () => {
  it('passes limit to findPlayerIds', async () => {
    const directory = makeDirectory();
    const svc = makeSvc({ directory });
    await svc.searchMentions('ali', 5, CLAIMER_ID);
    expect(directory.findPlayerIds).toHaveBeenCalledWith('ali', 5);
  });

  it('returns empty array when no ids found', async () => {
    const directory = mock<AdminUserDirectory>({
      findPlayerIds: vi.fn().mockResolvedValue([]),
      lookupPlayers: vi.fn().mockResolvedValue([]),
    });
    const svc = makeSvc({ directory });
    const result = await svc.searchMentions('xyz', 10, CLAIMER_ID);
    expect(result).toEqual([]);
  });

  it('excludes ids the viewer has blocked or ignored', async () => {
    const directory = makeDirectory();
    const blockWriter = mock<ChatBlockWriter>({
      blockUser: vi.fn().mockResolvedValue(undefined),
      ignoreUser: vi.fn().mockResolvedValue(undefined),
      getExcludedUserIds: vi.fn().mockResolvedValue([ACTOR_ID]),
    });
    const svc = makeSvc({ directory, blockWriter });
    const result = await svc.searchMentions('bo', 5, CLAIMER_ID);
    expect(blockWriter.getExcludedUserIds).toHaveBeenCalledWith(CLAIMER_ID);
    expect(result).toEqual([]);
  });
});

describe('ChatCommandsService.searchPlayers', () => {
  it('returns mapped player search results', async () => {
    const directory = makeDirectory();
    const svc = makeSvc({ directory });
    const result = await svc.searchPlayers('bo', 5, CLAIMER_ID);
    expect(directory.findPlayerIds).toHaveBeenCalledWith('bo', 5);
    expect(result).toEqual([{ userId: ACTOR_ID, username: 'bob', avatarUrl: null, level: 3 }]);
  });

  it('returns empty array when no matches', async () => {
    const directory = mock<AdminUserDirectory>({
      findPlayerIds: vi.fn().mockResolvedValue([]),
      lookupPlayers: vi.fn().mockResolvedValue([]),
    });
    const svc = makeSvc({ directory });
    const result = await svc.searchPlayers('xyz', 10, CLAIMER_ID);
    expect(result).toEqual([]);
  });

  it('excludes ids the viewer has blocked or ignored', async () => {
    const directory = makeDirectory();
    const blockWriter = mock<ChatBlockWriter>({
      blockUser: vi.fn().mockResolvedValue(undefined),
      ignoreUser: vi.fn().mockResolvedValue(undefined),
      getExcludedUserIds: vi.fn().mockResolvedValue([ACTOR_ID]),
    });
    const svc = makeSvc({ directory, blockWriter });
    const result = await svc.searchPlayers('bo', 5, CLAIMER_ID);
    expect(blockWriter.getExcludedUserIds).toHaveBeenCalledWith(CLAIMER_ID);
    expect(result).toEqual([]);
  });
});

describe('ChatCommandsService.getPlayerProfile', () => {
  it('returns the full profile card on the happy path', async () => {
    const gameReporting = makeGameReporting();
    const svc = makeSvc({ directory: makeDirectory(), gameReporting });
    const result = await svc.getPlayerProfile(ACTOR_ID);
    expect(gameReporting.getPlayerStats).toHaveBeenCalledWith(ACTOR_ID);
    expect(result).toEqual({
      userId: ACTOR_ID,
      username: 'bob',
      avatarUrl: null,
      level: 3,
      joinedAt: DIRECTORY_CREATED_AT.toISOString(),
      totalWagered: '100.00000000',
      totalBets: 5,
      currency: 'USD',
    });
  });

  it('throws ChatPlayerNotFoundError for an unknown userId', async () => {
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: vi.fn().mockResolvedValue([]),
    });
    const svc = makeSvc({ directory });
    await expect(svc.getPlayerProfile(CLAIMER_ID)).rejects.toThrow(ChatPlayerNotFoundError);
  });
});

describe('ChatCommandsService.executeCommand (gift)', () => {
  it('throws CommandDisabledError when command row is missing', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[]] } });
    await expect(
      svc.executeCommand({ type: 'gift', amount: '10', roomId: ROOM_ID }, ACTOR_ID),
    ).rejects.toThrow(CommandDisabledError);
  });

  it('throws CommandDisabledError when command is disabled', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[DISABLED_ROW]] } });
    await expect(
      svc.executeCommand({ type: 'gift', amount: '10', roomId: ROOM_ID }, ACTOR_ID),
    ).rejects.toThrow(CommandDisabledError);
  });

  it('throws InsufficientBalanceError when wallet debit fails', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[ENABLED_ROW]],
        // First returning is for chatGift insert (never reached); wallet fails first.
        returning: [],
      },
      wallet: makeWallet(false),
    });
    await expect(
      svc.executeCommand({ type: 'gift', amount: '10', roomId: ROOM_ID }, ACTOR_ID),
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it('posts system message with new gift metadata on success', async () => {
    const writer = makeWriter();
    const svc = makeSvc({
      drizzleRows: {
        select: [[ENABLED_ROW]],
        // First returning: chatGift insert; second returning: messageId back-fill update.
        returning: [[{ ...GIFT_ROW }], []],
      },
      writer,
    });
    const result = await svc.executeCommand(
      { type: 'gift', amount: '10.00000000', roomId: ROOM_ID },
      ACTOR_ID,
    );
    expect(writer.postSystemMessage).toHaveBeenCalledOnce();
    expect(writer.postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          command: 'gift',
          giftId: GIFT_ID,
          senderId: ACTOR_ID,
          senderUsername: 'bob',
        }),
      }),
    );
    expect(result.id).toBe(MSG_ID);
  });

  it('enforces minAmount from config', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[{ ...ENABLED_ROW, config: { minAmount: '5.00000000' } }]],
      },
    });
    await expect(
      svc.executeCommand({ type: 'gift', amount: '1.00000000', roomId: ROOM_ID }, ACTOR_ID),
    ).rejects.toThrow(BelowMinimumError);
  });
});

describe('ChatCommandsService.claimGift', () => {
  it('credits the claimer and returns claim info on happy path', async () => {
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: {
        // select[0]: gift lookup; returning[0]: atomic update result
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
    });
    const result = await svc.claimGift(GIFT_ID, CLAIMER_ID);
    expect(wallet.credit).toHaveBeenCalledOnce();
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: CLAIMER_ID, type: 'gift' }),
    );
    expect(result.claimedBy).toBe(CLAIMER_ID);
    expect(result.claimedByUsername).toBe('alice');
    expect(result.claimedAt).toEqual(expect.any(String));
  });

  it('throws GiftSelfClaimError when sender tries to claim their own gift', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[GIFT_ROW]], // senderId === ACTOR_ID
        returning: [],
      },
    });
    await expect(svc.claimGift(GIFT_ID, ACTOR_ID)).rejects.toThrow(GiftSelfClaimError);
  });

  it('throws GiftAlreadyClaimedError when update returns no rows (race lost)', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[GIFT_ROW]],
        returning: [[]], // empty = already claimed
      },
    });
    await expect(svc.claimGift(GIFT_ID, CLAIMER_ID)).rejects.toThrow(GiftAlreadyClaimedError);
  });

  it('throws GiftNotFoundError when gift does not exist', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[]], // no gift row
        returning: [],
      },
    });
    await expect(svc.claimGift(GIFT_ID, CLAIMER_ID)).rejects.toThrow(GiftNotFoundError);
  });
});

describe('ChatCommandsService.adminUpdateCommand', () => {
  it('upserts the command row and returns the descriptor', async () => {
    const updatedRow = { ...ENABLED_ROW, key: 'gift', enabled: false };
    const svc = makeSvc({
      drizzleRows: { returning: [[updatedRow]] },
    });
    const result = await svc.adminUpdateCommand({ key: 'gift', enabled: false }, ACTOR_ID);
    expect(result.key).toBe('gift');
    expect(result.enabled).toBe(false);
  });

  it('records an audit entry on update', async () => {
    const updatedRow = { ...ENABLED_ROW, key: 'rain', enabled: false };
    const audit = makeAudit();
    const drizzle = makeDrizzle({ select: [], returning: [[updatedRow]] });
    const svcWithAudit = new ChatCommandsService(
      drizzle,
      makeWriter(),
      makeWallet(),
      makeDirectory(),
      audit,
      makeTransport(),
      mock(makeEventBus()),
      makeBlockWriter(),
      makeGameReporting(),
    );
    await svcWithAudit.adminUpdateCommand({ key: 'rain', enabled: false }, ACTOR_ID);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ACTOR_ID,
        actorType: 'admin',
        action: 'chat.command.updated',
        resourceId: 'rain',
      }),
    );
  });
});

describe('ChatCommandsService.handleRain', () => {
  const RAIN_ROW = { ...ENABLED_ROW, key: 'rain', label: 'Rain' };

  it('throws NoOnlineUsersError when no other users are online', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[RAIN_ROW]] },
      transport: makeTransport([ACTOR_ID]),
    });
    await expect(
      svc.executeCommand(
        { type: 'rain', amount: '10.00000000', recipientCount: 5, roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(NoOnlineUsersError);
  });

  it('distributes to online recipients excluding the actor', async () => {
    const RECIPIENT_2 = '00000000-0000-0000-0000-000000000006';
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: {
        select: [[RAIN_ROW]],
        execute: [[{ per_recipient: '5.00000000' }]],
      },
      wallet,
      transport: makeTransport([ACTOR_ID, CLAIMER_ID, RECIPIENT_2]),
    });
    await svc.executeCommand(
      { type: 'rain', amount: '10.00000000', recipientCount: 2, roomId: ROOM_ID },
      ACTOR_ID,
    );
    expect(wallet.credit).toHaveBeenCalledTimes(2);
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: CLAIMER_ID,
      amount: '5.00000000',
      type: 'rain',
    });
  });

  it('uses Postgres floor division to avoid float imprecision', async () => {
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: {
        select: [[RAIN_ROW]],
        execute: [[{ per_recipient: '3.33333333' }]],
      },
      wallet,
      transport: makeTransport([
        CLAIMER_ID,
        '00000000-0000-0000-0000-000000000006',
        '00000000-0000-0000-0000-000000000007',
      ]),
    });
    await svc.executeCommand(
      { type: 'rain', amount: '10.00000000', recipientCount: 3, roomId: ROOM_ID },
      ACTOR_ID,
    );
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: expect.any(String),
      amount: '3.33333333',
      type: 'rain',
    });
  });

  it('throws BelowMinimumError when amount is below config minAmount', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[{ ...RAIN_ROW, config: { minAmount: '5.00000000' } }]],
      },
    });
    await expect(
      svc.executeCommand(
        { type: 'rain', amount: '1.00000000', recipientCount: 1, roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(BelowMinimumError);
  });

  it('throws ExceedsLimitError when amount is above config maxAmount', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[{ ...RAIN_ROW, config: { maxAmount: '10.00000000' } }]],
      },
    });
    await expect(
      svc.executeCommand(
        { type: 'rain', amount: '50.00000000', recipientCount: 1, roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(ExceedsLimitError);
  });

  it('throws ExceedsLimitError when recipientCount exceeds config maxRecipients', async () => {
    const svc = makeSvc({
      drizzleRows: {
        select: [[{ ...RAIN_ROW, config: { maxRecipients: 10 } }]],
      },
    });
    await expect(
      svc.executeCommand(
        { type: 'rain', amount: '100.00000000', recipientCount: 11, roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(ExceedsLimitError);
  });

  it('throws TooManyRecipientsError when recipientCount exceeds the whole-dollar amount', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[RAIN_ROW]] },
    });
    await expect(
      svc.executeCommand(
        { type: 'rain', amount: '3.00000000', recipientCount: 4, roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(TooManyRecipientsError);
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

const DONATE_SYSTEM_MSG: import('@openora/core/contracts').ChatSystemMessage = {
  id: MSG_ID,
  roomId: ROOM_ID,
  actorId: ACTOR_ID,
  content: '',
  metadata: {
    command: 'donate',
    recipientId: CLAIMER_ID,
    recipientUsername: 'alice',
    amount: '10.00000000',
    currency: 'USD',
  },
  createdAt: new Date().toISOString(),
};

/**
 * Directory mock where findPlayerIds resolves the RECIPIENT (CLAIMER_ID = 'alice').
 * Used for donate tests that target 'alice' — the default makeDirectory() always
 * returns ACTOR_ID which only has username 'bob', so alice is never found.
 */
function makeRecipientDirectory(): import('@openora/core/contracts').AdminUserDirectory {
  return mock<import('@openora/core/contracts').AdminUserDirectory>({
    findPlayerIds: vi.fn().mockResolvedValue([CLAIMER_ID]),
    lookupPlayers: vi.fn().mockImplementation((ids: string[]) => {
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
      return Promise.resolve(all.filter((p) => ids.includes(p.userId)));
    }),
  });
}

describe('ChatCommandsService.handleDonate', () => {
  it('debits sender, credits recipient, and returns system message on success', async () => {
    const wallet = makeWallet();
    const writer = mock<import('@openora/core/contracts').ChatSystemWriter>({
      postSystemMessage: vi.fn().mockResolvedValue(DONATE_SYSTEM_MSG),
    });
    const svc = makeSvc({
      drizzleRows: { select: [[DONATE_ROW]] },
      wallet,
      writer,
      directory: makeRecipientDirectory(),
    });
    const result = await svc.executeCommand(
      { type: 'donate', targetUsername: 'alice', amount: '10.00000000', roomId: ROOM_ID },
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
      type: 'tip',
    });
    expect(result.id).toBe(MSG_ID);
  });

  it('throws DonateSelfError when sender targets themselves', async () => {
    // Default makeDirectory() returns ACTOR_ID ('bob') from findPlayerIds — correct for self-target.
    const svc = makeSvc({
      drizzleRows: { select: [[DONATE_ROW]] },
    });
    await expect(
      svc.executeCommand(
        { type: 'donate', targetUsername: 'bob', amount: '10.00000000', roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(DonateSelfError);
  });

  it('throws ChatPlayerNotFoundError when target username does not exist', async () => {
    const directory = mock<import('@openora/core/contracts').AdminUserDirectory>({
      findPlayerIds: vi.fn().mockResolvedValue([]),
      lookupPlayers: vi.fn().mockResolvedValue([]),
    });
    const svc = makeSvc({
      drizzleRows: { select: [[DONATE_ROW]] },
      directory,
    });
    await expect(
      svc.executeCommand(
        { type: 'donate', targetUsername: 'ghost', amount: '10.00000000', roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(ChatPlayerNotFoundError);
  });

  it('throws InsufficientBalanceError when sender wallet debit fails', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[DONATE_ROW]] },
      wallet: makeWallet(false),
      directory: makeRecipientDirectory(),
    });
    await expect(
      svc.executeCommand(
        { type: 'donate', targetUsername: 'alice', amount: '10.00000000', roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it('throws BelowMinimumError when amount is below config minAmount', async () => {
    // Amount check fires before directory lookup, so directory mock does not matter here.
    const svc = makeSvc({
      drizzleRows: {
        select: [[{ ...DONATE_ROW, config: { minAmount: '5.00000000' } }]],
      },
    });
    await expect(
      svc.executeCommand(
        { type: 'donate', targetUsername: 'alice', amount: '1.00000000', roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(BelowMinimumError);
  });
});

const BLOCK_ROW = { ...ENABLED_ROW, key: 'block', label: 'Block' };
const IGNORE_ROW = { ...ENABLED_ROW, key: 'ignore', label: 'Ignore' };

describe('ChatCommandsService.handleBlockAction', () => {
  it('dispatches "block" to blockWriter.blockUser, not ignoreUser', async () => {
    const blockWriter = makeBlockWriter();
    const svc = makeSvc({
      drizzleRows: { select: [[BLOCK_ROW]] },
      directory: makeRecipientDirectory(),
      blockWriter,
    });

    await svc.executeCommand({ type: 'block', targetUsername: 'alice', roomId: ROOM_ID }, ACTOR_ID);

    expect(blockWriter.blockUser).toHaveBeenCalledWith(ACTOR_ID, CLAIMER_ID);
    expect(blockWriter.ignoreUser).not.toHaveBeenCalled();
  });

  it('dispatches "ignore" to blockWriter.ignoreUser, not blockUser', async () => {
    const blockWriter = makeBlockWriter();
    const svc = makeSvc({
      drizzleRows: { select: [[IGNORE_ROW]] },
      directory: makeRecipientDirectory(),
      blockWriter,
    });

    await svc.executeCommand(
      { type: 'ignore', targetUsername: 'alice', roomId: ROOM_ID },
      ACTOR_ID,
    );

    expect(blockWriter.ignoreUser).toHaveBeenCalledWith(ACTOR_ID, CLAIMER_ID);
    expect(blockWriter.blockUser).not.toHaveBeenCalled();
  });

  it('throws SelfModerationActionError on self-block', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[BLOCK_ROW]] },
    });

    await expect(
      svc.executeCommand({ type: 'block', targetUsername: 'bob', roomId: ROOM_ID }, ACTOR_ID),
    ).rejects.toThrow(SelfModerationActionError);
  });

  it('throws SelfModerationActionError on self-ignore', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[IGNORE_ROW]] },
    });

    await expect(
      svc.executeCommand({ type: 'ignore', targetUsername: 'bob', roomId: ROOM_ID }, ACTOR_ID),
    ).rejects.toThrow(SelfModerationActionError);
  });
});

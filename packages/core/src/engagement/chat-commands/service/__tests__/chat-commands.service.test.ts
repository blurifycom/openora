import { describe, it, expect, vi } from 'vitest';
import { mock, makeDrizzle, makeEvents } from '../../../../testing/mock.js';
import type {
  ChatSystemMessage,
  ChatSystemWriter,
  ChatBlockWriter,
  WalletCommands,
  AdminUserDirectory,
  AuditWritePort,
  RealtimeTransport,
} from '@openora/core/contracts';
import {
  ChatCommandsService,
  CommandDisabledError,
  InsufficientBalanceError,
  BelowMinimumError,
  NoOnlineUsersError,
  GiftNotFoundError,
  GiftAlreadyClaimedError,
  GiftSelfClaimError,
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
        },
        {
          userId: CLAIMER_ID,
          username: claimerUsername,
          email: 'alice@example.com',
          kycStatus: null,
          language: null,
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
  return mock<ChatBlockWriter>({ blockUser: vi.fn().mockResolvedValue(undefined) });
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
    mock(makeEvents()),
    makeBlockWriter(),
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
    await svc.searchMentions('ali', 5);
    expect(directory.findPlayerIds).toHaveBeenCalledWith('ali', 5);
  });

  it('returns empty array when no ids found', async () => {
    const directory = mock<AdminUserDirectory>({
      findPlayerIds: vi.fn().mockResolvedValue([]),
      lookupPlayers: vi.fn().mockResolvedValue([]),
    });
    const svc = makeSvc({ directory });
    const result = await svc.searchMentions('xyz', 10);
    expect(result).toEqual([]);
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
      mock(makeEvents()),
      makeBlockWriter(),
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
      svc.executeCommand({ type: 'rain', amount: '10.00000000', roomId: ROOM_ID }, ACTOR_ID),
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
    await svc.executeCommand({ type: 'rain', amount: '10.00000000', roomId: ROOM_ID }, ACTOR_ID);
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
        // Postgres floor(1::numeric / 3)::text = '0.33333333' (scale 8 from the input)
        execute: [[{ per_recipient: '0.33333333' }]],
      },
      wallet,
      transport: makeTransport([
        CLAIMER_ID,
        '00000000-0000-0000-0000-000000000006',
        '00000000-0000-0000-0000-000000000007',
      ]),
    });
    await svc.executeCommand({ type: 'rain', amount: '1.00000000', roomId: ROOM_ID }, ACTOR_ID);
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: expect.any(String),
      amount: '0.33333333',
      type: 'rain',
    });
  });
});

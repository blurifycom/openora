import { describe, it, expect, vi } from 'vitest';
import { mock, makeDrizzle } from '../../../../testing/mock.js';
import type {
  CommandChatMessage,
  ChatBlockWriter,
  AdminUserDirectory,
  GiftCommands,
  SendGiftResult,
  ClaimGiftResult,
  GetGiftResult,
  RainCommands,
  SendRainResult,
  RealtimeTransport,
  AuditWritePort,
} from '@openora/core/contracts';
import {
  ChatCommandsService,
  CommandDisabledError,
  InsufficientBalanceError,
  NoOnlineUsersError,
  GiftNotFoundError,
  GiftAlreadyClaimedError,
  ChatRoomNotMemberError,
} from '../chat-commands.service.js';

const ACTOR_ID = '00000000-0000-0000-0000-000000000001';
const CLAIMER_ID = '00000000-0000-0000-0000-000000000002';
const ROOM_ID = '00000000-0000-0000-0000-000000000003';
const MSG_ID = '00000000-0000-0000-0000-000000000004';
const GIFT_ID = '00000000-0000-0000-0000-000000000005';
const IDEMPOTENCY_KEY = '00000000-0000-0000-0000-0000000000aa';

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
  userId: ACTOR_ID,
  username: 'bob',
  content: '',
  type: 'user',
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

function makeDirectory(): AdminUserDirectory {
  return mock<AdminUserDirectory>({
    findPlayerIds: vi.fn().mockResolvedValue([ACTOR_ID]),
    lookupPlayers: vi
      .fn()
      .mockImplementation((ids: string[]) =>
        Promise.resolve(
          ids.filter((id) => id === ACTOR_ID).map((id) => ({ userId: id, username: 'bob' })),
        ),
      ),
  });
}

function makeBlockWriter(excluded: string[] = []): ChatBlockWriter {
  return mock<ChatBlockWriter>({
    blockUser: vi.fn().mockResolvedValue(undefined),
    ignoreUser: vi.fn().mockResolvedValue(undefined),
    getExcludedUserIds: vi.fn().mockResolvedValue(excluded),
  });
}

const GIFT_STATE = {
  id: GIFT_ID,
  senderId: ACTOR_ID,
  senderUsername: 'bob',
  amount: '10.00000000',
  currency: 'USD',
  claimedBy: null,
  claimedByUsername: null,
  claimedAt: null,
  createdAt: new Date().toISOString(),
};

function makeGiftCommands(overrides: Partial<GiftCommands> = {}): GiftCommands {
  return mock<GiftCommands>({
    sendGift: vi.fn().mockResolvedValue({ ok: true, message: SYSTEM_MSG } satisfies SendGiftResult),
    claimGift: vi.fn().mockResolvedValue({
      ok: true,
      claimedBy: CLAIMER_ID,
      claimedByUsername: 'alice',
      claimedAt: new Date().toISOString(),
    } satisfies ClaimGiftResult),
    getGift: vi.fn().mockResolvedValue({ ok: true, gift: GIFT_STATE } satisfies GetGiftResult),
    ...overrides,
  });
}

function makeRainCommands(overrides: Partial<RainCommands> = {}): RainCommands {
  return mock<RainCommands>({
    sendRain: vi.fn().mockResolvedValue({ ok: true, message: SYSTEM_MSG } satisfies SendRainResult),
    ...overrides,
  });
}

function makeTransport(onlineIds: string[] = [CLAIMER_ID]): RealtimeTransport {
  return mock<RealtimeTransport>({
    getOnlineUserIds: vi.fn().mockResolvedValue(onlineIds),
  });
}

function makeAudit(): AuditWritePort {
  return mock<AuditWritePort>({
    record: vi.fn().mockResolvedValue(undefined),
    recordInTransaction: vi.fn().mockResolvedValue(undefined),
  });
}

function makeSvc(
  overrides: {
    drizzleRows?: {
      select?: Record<string, unknown>[][];
      returning?: Record<string, unknown>[][];
    };
    directory?: AdminUserDirectory;
    blockWriter?: ChatBlockWriter;
    giftCommands?: GiftCommands;
    rainCommands?: RainCommands;
    transport?: RealtimeTransport;
    audit?: AuditWritePort;
  } = {},
) {
  const drizzle = makeDrizzle({
    select: overrides.drizzleRows?.select ?? [],
    returning: overrides.drizzleRows?.returning ?? [],
  });
  return new ChatCommandsService(
    drizzle,
    overrides.directory ?? makeDirectory(),
    overrides.blockWriter ?? makeBlockWriter(),
    overrides.giftCommands ?? makeGiftCommands(),
    overrides.rainCommands ?? makeRainCommands(),
    overrides.transport ?? makeTransport(),
    overrides.audit ?? makeAudit(),
  );
}

describe('ChatCommandsService.listCommands', () => {
  it('returns only enabled commands by default', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[ENABLED_ROW]] } });
    const result = await svc.listCommands();
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe('gift');
  });

  it('returns all commands when includeDisabled is true', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[ENABLED_ROW, DISABLED_ROW]] } });
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
    const blockWriter = makeBlockWriter([ACTOR_ID]);
    const svc = makeSvc({ directory, blockWriter });
    const result = await svc.searchMentions('bo', 5, CLAIMER_ID);
    expect(blockWriter.getExcludedUserIds).toHaveBeenCalledWith(CLAIMER_ID);
    expect(result).toEqual([]);
  });
});

describe('ChatCommandsService.postGift (delegates to GIFT_COMMANDS)', () => {
  it('returns the message from the port on success', async () => {
    const giftCommands = makeGiftCommands();
    const svc = makeSvc({ giftCommands });

    const result = await svc.postGift(
      { amount: '10.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );

    expect(giftCommands.sendGift).toHaveBeenCalledWith(
      { amount: '10.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
      ACTOR_ID,
    );
    expect(result).toEqual(SYSTEM_MSG);
  });

  it('maps a "disabled" port result to CommandDisabledError', async () => {
    const giftCommands = makeGiftCommands({
      sendGift: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'disabled' } satisfies SendGiftResult),
    });
    const svc = makeSvc({ giftCommands });

    await expect(
      svc.postGift(
        { amount: '10.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
        ACTOR_ID,
      ),
    ).rejects.toThrow(CommandDisabledError);
  });

  it('maps an "insufficient_balance" port result to InsufficientBalanceError', async () => {
    const giftCommands = makeGiftCommands({
      sendGift: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'insufficient_balance' } satisfies SendGiftResult),
    });
    const svc = makeSvc({ giftCommands });

    await expect(
      svc.postGift(
        { amount: '10.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
        ACTOR_ID,
      ),
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it('maps a "room_not_member" port result to ChatRoomNotMemberError', async () => {
    const giftCommands = makeGiftCommands({
      sendGift: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'room_not_member' } satisfies SendGiftResult),
    });
    const svc = makeSvc({ giftCommands });

    await expect(
      svc.postGift(
        { amount: '10.00000000', roomId: ROOM_ID, idempotencyKey: IDEMPOTENCY_KEY },
        ACTOR_ID,
      ),
    ).rejects.toThrow(ChatRoomNotMemberError);
  });
});

describe('ChatCommandsService.claimGift (delegates to GIFT_COMMANDS)', () => {
  it('returns the claim info from the port on success', async () => {
    const giftCommands = makeGiftCommands();
    const svc = makeSvc({ giftCommands });

    const result = await svc.claimGift(GIFT_ID, CLAIMER_ID);

    expect(giftCommands.claimGift).toHaveBeenCalledWith(GIFT_ID, CLAIMER_ID);
    expect(result.claimedBy).toBe(CLAIMER_ID);
    expect(result.claimedByUsername).toBe('alice');
  });

  it('maps a "gift_not_found" port result to GiftNotFoundError', async () => {
    const giftCommands = makeGiftCommands({
      claimGift: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'gift_not_found' } satisfies ClaimGiftResult),
    });
    const svc = makeSvc({ giftCommands });

    await expect(svc.claimGift(GIFT_ID, CLAIMER_ID)).rejects.toThrow(GiftNotFoundError);
  });

  it('maps an "already_claimed" port result to GiftAlreadyClaimedError', async () => {
    const giftCommands = makeGiftCommands({
      claimGift: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'already_claimed' } satisfies ClaimGiftResult),
    });
    const svc = makeSvc({ giftCommands });

    await expect(svc.claimGift(GIFT_ID, CLAIMER_ID)).rejects.toThrow(GiftAlreadyClaimedError);
  });

  it('maps a "room_not_member" port result to ChatRoomNotMemberError using the port\'s roomId, not the giftId', async () => {
    const giftCommands = makeGiftCommands({
      claimGift: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'room_not_member',
        roomId: ROOM_ID,
      } satisfies ClaimGiftResult),
    });
    const svc = makeSvc({ giftCommands });

    await expect(svc.claimGift(GIFT_ID, CLAIMER_ID)).rejects.toThrow(
      new ChatRoomNotMemberError(ROOM_ID),
    );
  });
});

describe('ChatCommandsService.getGift (delegates to GIFT_COMMANDS)', () => {
  it('returns the gift state from the port on success', async () => {
    const giftCommands = makeGiftCommands();
    const svc = makeSvc({ giftCommands });

    const result = await svc.getGift(GIFT_ID, CLAIMER_ID);

    expect(giftCommands.getGift).toHaveBeenCalledWith(GIFT_ID, CLAIMER_ID);
    expect(result).toEqual(GIFT_STATE);
  });

  it('maps a "gift_not_found" port result to GiftNotFoundError', async () => {
    const giftCommands = makeGiftCommands({
      getGift: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'gift_not_found' } satisfies GetGiftResult),
    });
    const svc = makeSvc({ giftCommands });

    await expect(svc.getGift(GIFT_ID, CLAIMER_ID)).rejects.toThrow(GiftNotFoundError);
  });

  it('maps a "room_not_member" port result to ChatRoomNotMemberError using the port\'s roomId', async () => {
    const giftCommands = makeGiftCommands({
      getGift: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'room_not_member',
        roomId: ROOM_ID,
      } satisfies GetGiftResult),
    });
    const svc = makeSvc({ giftCommands });

    await expect(svc.getGift(GIFT_ID, CLAIMER_ID)).rejects.toThrow(
      new ChatRoomNotMemberError(ROOM_ID),
    );
  });
});

describe('ChatCommandsService.postRain (resolves presence, delegates to RAIN_COMMANDS)', () => {
  it('resolves online user ids via CHAT_REALTIME_TRANSPORT and passes them to the port', async () => {
    const RECIPIENT_2 = '00000000-0000-0000-0000-000000000006';
    const transport = makeTransport([ACTOR_ID, CLAIMER_ID, RECIPIENT_2]);
    const rainCommands = makeRainCommands();
    const svc = makeSvc({ transport, rainCommands });

    const result = await svc.postRain(
      {
        amount: '10.00000000',
        recipientCount: 2,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      ACTOR_ID,
    );

    expect(transport.getOnlineUserIds).toHaveBeenCalledWith(`chat:room:${ROOM_ID}`);
    expect(rainCommands.sendRain).toHaveBeenCalledWith(
      {
        amount: '10.00000000',
        recipientCount: 2,
        roomId: ROOM_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        onlineUserIds: [ACTOR_ID, CLAIMER_ID, RECIPIENT_2],
      },
      ACTOR_ID,
    );
    expect(result).toEqual(SYSTEM_MSG);
  });

  it('maps a "no_online_users" port result to NoOnlineUsersError', async () => {
    const rainCommands = makeRainCommands({
      sendRain: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'no_online_users' } satisfies SendRainResult),
    });
    const svc = makeSvc({ rainCommands, transport: makeTransport([ACTOR_ID]) });

    await expect(
      svc.postRain(
        {
          amount: '10.00000000',
          recipientCount: 2,
          roomId: ROOM_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        ACTOR_ID,
      ),
    ).rejects.toThrow(NoOnlineUsersError);
  });

  it('maps a "disabled" port result to CommandDisabledError', async () => {
    const rainCommands = makeRainCommands({
      sendRain: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'disabled' } satisfies SendRainResult),
    });
    const svc = makeSvc({ rainCommands });

    await expect(
      svc.postRain(
        {
          amount: '10.00000000',
          recipientCount: 2,
          roomId: ROOM_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        ACTOR_ID,
      ),
    ).rejects.toThrow(CommandDisabledError);
  });

  it('maps a "room_not_member" port result to ChatRoomNotMemberError', async () => {
    const rainCommands = makeRainCommands({
      sendRain: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'room_not_member' } satisfies SendRainResult),
    });
    const svc = makeSvc({ rainCommands });

    await expect(
      svc.postRain(
        {
          amount: '10.00000000',
          recipientCount: 2,
          roomId: ROOM_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        ACTOR_ID,
      ),
    ).rejects.toThrow(ChatRoomNotMemberError);
  });
});

describe('ChatCommandsService.adminListCommands', () => {
  it('returns disabled commands too, unlike listCommands', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW, DISABLED_ROW], [{ n: 2 }]] },
    });

    const result = await svc.adminListCommands({
      page: 1,
      limit: 10,
      sortBy: 'key',
      sortOrder: 'asc',
    });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.items.map((c) => c.enabled)).toEqual([true, false]);
  });
});

describe('ChatCommandsService.adminUpdateCommand', () => {
  it('creates a new config row when none exists', async () => {
    const row = { ...ENABLED_ROW, key: 'donate', label: 'Donate' };
    const svc = makeSvc({ drizzleRows: { returning: [[row]] } });

    const result = await svc.adminUpdateCommand({ key: 'donate', enabled: true }, ACTOR_ID);

    expect(result).toMatchObject({ key: 'donate', label: 'Donate', enabled: true });
  });

  it('updates an existing config row', async () => {
    const row = { ...ENABLED_ROW, enabled: false, config: { maxAmount: '100.00000000' } };
    const svc = makeSvc({ drizzleRows: { returning: [[row]] } });

    const result = await svc.adminUpdateCommand(
      { key: 'gift', enabled: false, config: { maxAmount: '100.00000000' } },
      ACTOR_ID,
    );

    expect(result).toMatchObject({ key: 'gift', enabled: false });
  });

  it('records an audit entry describing the change', async () => {
    const audit = makeAudit();
    const svc = makeSvc({ audit, drizzleRows: { returning: [[ENABLED_ROW]] } });

    await svc.adminUpdateCommand(
      { key: 'gift', enabled: true, config: { maxAmount: '50.00000000' } },
      ACTOR_ID,
    );

    expect(audit.record).toHaveBeenCalledWith({
      actorId: ACTOR_ID,
      actorType: 'admin',
      action: 'chat.command.updated',
      resourceType: 'chat_command',
      resourceId: 'gift',
      before: null,
      after: { enabled: true, config: { maxAmount: '50.00000000' } },
    });
  });

  it('throws CommandDisabledError when the insert/update returns no row', async () => {
    const svc = makeSvc({ drizzleRows: { returning: [[]] } });

    await expect(svc.adminUpdateCommand({ key: 'gift', enabled: true }, ACTOR_ID)).rejects.toThrow(
      CommandDisabledError,
    );
  });
});

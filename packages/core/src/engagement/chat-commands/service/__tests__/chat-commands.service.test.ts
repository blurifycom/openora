import { describe, it, expect, vi } from 'vitest';
import { mock, makeDrizzle, makeEvents } from '../../../../testing/mock.js';
import type {
  ChatSystemMessage,
  ChatSystemWriter,
  WalletCommands,
  AdminUserDirectory,
  AuditWritePort,
  RealtimeTransport,
} from '@openora/core/contracts';
import {
  ChatCommandsService,
  CommandDisabledError,
  InsufficientBalanceError,
  NoOnlineUsersError,
  ChatPlayerNotFoundError,
} from '../chat-commands.service.js';

const ACTOR_ID = '00000000-0000-0000-0000-000000000001';
const TARGET_ID = '00000000-0000-0000-0000-000000000002';
const ROOM_ID = '00000000-0000-0000-0000-000000000003';
const MSG_ID = '00000000-0000-0000-0000-000000000004';

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
    fromUserId: ACTOR_ID,
    toUserId: TARGET_ID,
    amount: '10.00000000',
    currency: 'USD',
  },
  createdAt: new Date().toISOString(),
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

function makeDirectory(ids: string[] = [TARGET_ID]): AdminUserDirectory {
  return mock<AdminUserDirectory>({
    findPlayerIds: vi.fn().mockResolvedValue(ids),
    lookupPlayers: vi.fn().mockResolvedValue([
      {
        userId: TARGET_ID,
        username: 'alice',
        email: 'alice@example.com',
        kycStatus: null,
        language: null,
      },
    ]),
  });
}

function makeAudit(): AuditWritePort {
  return mock<AuditWritePort>({ record: vi.fn().mockResolvedValue(undefined) });
}

function makeTransport(onlineIds: string[] = [TARGET_ID]): RealtimeTransport {
  return mock<RealtimeTransport>({
    getOnlineUserIds: vi.fn().mockResolvedValue(onlineIds),
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
    makeAudit(),
    overrides.transport ?? makeTransport(),
    mock(makeEvents()),
  );
}

describe('ChatCommandsService.listCommands', () => {
  it('returns only enabled commands by default', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW, DISABLED_ROW]] },
    });
    const result = await svc.listCommands();
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe('gift');
  });

  it('returns all commands when includeDisabled is true', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW, DISABLED_ROW]] },
    });
    const result = await svc.listCommands(true);
    expect(result).toHaveLength(2);
  });
});

describe('ChatCommandsService.searchMentions', () => {
  it('passes limit to findPlayerIds', async () => {
    const directory = makeDirectory([TARGET_ID]);
    const svc = makeSvc({ directory });
    await svc.searchMentions('ali', 5);
    expect(directory.findPlayerIds).toHaveBeenCalledWith('ali', 5);
  });

  it('returns empty array when no ids found', async () => {
    const directory = makeDirectory([]);
    const svc = makeSvc({ directory });
    const result = await svc.searchMentions('xyz', 10);
    expect(result).toEqual([]);
  });
});

describe('ChatCommandsService.executeCommand', () => {
  it('throws CommandDisabledError when command row is missing', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[]] } });
    await expect(
      svc.executeCommand(
        { type: 'gift', targetUsername: 'alice', amount: '10', roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(CommandDisabledError);
  });

  it('throws CommandDisabledError when command is disabled', async () => {
    const svc = makeSvc({ drizzleRows: { select: [[DISABLED_ROW]] } });
    await expect(
      svc.executeCommand(
        { type: 'gift', targetUsername: 'alice', amount: '10', roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(CommandDisabledError);
  });

  it('throws ChatPlayerNotFoundError when target username has no match', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW]] },
      directory: makeDirectory([]),
    });
    await expect(
      svc.executeCommand(
        { type: 'gift', targetUsername: 'ghost', amount: '10', roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(ChatPlayerNotFoundError);
  });

  it('throws InsufficientBalanceError when wallet debit fails', async () => {
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW]] },
      wallet: makeWallet(false),
    });
    await expect(
      svc.executeCommand(
        { type: 'gift', targetUsername: 'alice', amount: '10', roomId: ROOM_ID },
        ACTOR_ID,
      ),
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it('posts system message and returns it on a successful gift', async () => {
    const writer = makeWriter();
    const svc = makeSvc({
      drizzleRows: { select: [[ENABLED_ROW]] },
      writer,
    });
    const result = await svc.executeCommand(
      { type: 'gift', targetUsername: 'alice', amount: '10.00000000', roomId: ROOM_ID },
      ACTOR_ID,
    );
    expect(writer.postSystemMessage).toHaveBeenCalledOnce();
    expect(result.id).toBe(MSG_ID);
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
    const RECIPIENT_2 = '00000000-0000-0000-0000-000000000005';
    const wallet = makeWallet();
    const svc = makeSvc({
      drizzleRows: {
        select: [[RAIN_ROW]],
        execute: [[{ per_recipient: '5.00000000' }]],
      },
      wallet,
      transport: makeTransport([ACTOR_ID, TARGET_ID, RECIPIENT_2]),
    });
    await svc.executeCommand({ type: 'rain', amount: '10.00000000', roomId: ROOM_ID }, ACTOR_ID);
    expect(wallet.credit).toHaveBeenCalledTimes(2);
    expect(wallet.credit).toHaveBeenCalledWith(expect.anything(), {
      userId: TARGET_ID,
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
        TARGET_ID,
        '00000000-0000-0000-0000-000000000005',
        '00000000-0000-0000-0000-000000000006',
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

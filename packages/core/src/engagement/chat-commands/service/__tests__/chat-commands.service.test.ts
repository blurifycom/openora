import { describe, expect, it, vi } from 'vitest';
import { mock, makeDrizzle } from '../../../../testing/mock.js';
import type {
  AdminUserDirectory,
  AuditWritePort,
  ChatBlockWriter,
  RealtimeTransport,
} from '@openora/core/contracts';
import { ChatCommandsService } from '../chat-commands.service.js';

const ENABLED_ROW = {
  key: 'gift',
  enabled: true,
  label: 'Gift',
  description: null,
  config: null,
  updatedAt: new Date(),
};
const DISABLED_ROW = { ...ENABLED_ROW, enabled: false };

function makeService(select: Record<string, unknown>[][] = []) {
  return new ChatCommandsService(
    makeDrizzle({ select }),
    mock<AdminUserDirectory>({
      findPlayerIds: vi.fn().mockResolvedValue([]),
      lookupPlayers: vi.fn().mockResolvedValue([]),
    }),
    mock<ChatBlockWriter>({ getExcludedUserIds: vi.fn().mockResolvedValue([]) }),
    mock<RealtimeTransport>({ getOnlineUserIds: vi.fn().mockResolvedValue([]) }),
    mock<AuditWritePort>({ record: vi.fn().mockResolvedValue(undefined) }),
  );
}

type MentionDeps = {
  onlineUserIds?: string[];
  findPlayerIds?: string[];
  players?: { userId: string; username: string }[];
  excludedUserIds?: string[];
  accounts?: { id: string; name: string | null; email: string; role: string }[];
  viewerRole?: string;
};

function makeMentionService(deps: MentionDeps = {}) {
  const players = deps.players ?? [];
  return new ChatCommandsService(
    makeDrizzle({ select: [] }),
    mock<AdminUserDirectory>({
      findPlayerIds: vi.fn().mockResolvedValue(deps.findPlayerIds ?? []),
      lookupPlayers: vi
        .fn()
        .mockImplementation(async (ids: readonly string[]) =>
          players.filter((p) => ids.includes(p.userId)),
        ),
      lookupUsers: vi
        .fn()
        .mockImplementation(async (ids: readonly string[]) =>
          (deps.accounts ?? []).filter((a) => ids.includes(a.id)),
        ),
      ...(deps.viewerRole === undefined
        ? {}
        : { get: vi.fn().mockResolvedValue({ id: 'viewer', role: deps.viewerRole }) }),
    }),
    mock<ChatBlockWriter>({
      getExcludedUserIds: vi.fn().mockResolvedValue(deps.excludedUserIds ?? []),
    }),
    mock<RealtimeTransport>({
      getOnlineUserIds: vi.fn().mockResolvedValue(deps.onlineUserIds ?? []),
    }),
    mock<AuditWritePort>({ record: vi.fn().mockResolvedValue(undefined) }),
  );
}

const SEARCH = { limit: 20, roomId: null, viewerId: 'viewer' } as const;

describe('ChatCommandsService command registry', () => {
  it('returns only enabled commands by default', async () => {
    const result = await makeService([[ENABLED_ROW]]).listCommands();

    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe('gift');
  });

  it('returns disabled commands for administrators', async () => {
    const result = await makeService([[ENABLED_ROW, DISABLED_ROW], [{ n: 2 }]]).adminListCommands({
      page: 1,
      limit: 10,
      sortBy: 'key',
      sortOrder: 'asc',
    });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
  });
});

describe('ChatCommandsService searchMentions', () => {
  it('matches a player who is not online for a typed query', async () => {
    const service = makeMentionService({
      onlineUserIds: [],
      findPlayerIds: ['offline-1'],
      players: [{ userId: 'offline-1', username: 'alice' }],
    });

    const result = await service.searchMentions({ ...SEARCH, q: 'ali' });

    expect(result).toEqual([{ userId: 'offline-1', username: 'alice' }]);
  });

  it('returns nothing for an empty query when the room is empty', async () => {
    const service = makeMentionService({ onlineUserIds: [] });

    expect(await service.searchMentions({ ...SEARCH, q: '' })).toEqual([]);
  });

  it('lists only online users for an empty query', async () => {
    const service = makeMentionService({
      onlineUserIds: ['on-1', 'on-2'],
      players: [
        { userId: 'on-1', username: 'bob' },
        { userId: 'on-2', username: 'carol' },
      ],
    });

    const result = await service.searchMentions({ ...SEARCH, q: '' });

    expect(result).toEqual([
      { userId: 'on-1', username: 'bob' },
      { userId: 'on-2', username: 'carol' },
    ]);
  });

  it('excludes the caller and blocked users from a typed query', async () => {
    const service = makeMentionService({
      onlineUserIds: [],
      findPlayerIds: ['viewer', 'wanted', 'blocked'],
      excludedUserIds: ['blocked'],
      players: [
        { userId: 'wanted', username: 'dave' },
        { userId: 'blocked', username: 'erin' },
      ],
    });

    const result = await service.searchMentions({ ...SEARCH, q: 'e' });

    expect(result).toEqual([{ userId: 'wanted', username: 'dave' }]);
  });

  it('excludes the caller and blocked users before limiting a typed query', async () => {
    const findPlayerIds = vi.fn().mockResolvedValue(['wanted']);
    const service = new ChatCommandsService(
      makeDrizzle({ select: [] }),
      mock<AdminUserDirectory>({
        findPlayerIds,
        lookupPlayers: vi.fn().mockResolvedValue([{ userId: 'wanted', username: 'dave' }]),
      }),
      mock<ChatBlockWriter>({ getExcludedUserIds: vi.fn().mockResolvedValue(['blocked']) }),
      mock<RealtimeTransport>({ getOnlineUserIds: vi.fn().mockResolvedValue([]) }),
      mock<AuditWritePort>({ record: vi.fn().mockResolvedValue(undefined) }),
    );

    await service.searchMentions({ ...SEARCH, q: 'da', limit: 2 });

    expect(findPlayerIds).toHaveBeenCalledWith('da', 2, {
      excludeUserIds: ['blocked', 'viewer'],
      playerOnly: true,
    });
  });
});

describe('ChatCommandsService searchMentions staff visibility', () => {
  const STAFF = { id: 'staff-1', name: 'Sam Support', email: 'sam@ops.test', role: 'admin' };

  it('hides a staff account with no player row when it is offline', async () => {
    const service = makeMentionService({
      viewerRole: 'admin',
      onlineUserIds: [],
      findPlayerIds: ['staff-1'],
      accounts: [STAFF],
      players: [],
    });

    expect(await service.searchMentions({ ...SEARCH, q: 'sam' })).toEqual([]);
  });

  it('surfaces a staff account with no player row while it is online', async () => {
    const service = makeMentionService({
      viewerRole: 'admin',
      onlineUserIds: ['staff-1'],
      findPlayerIds: ['staff-1'],
      accounts: [STAFF],
      players: [],
    });

    expect(await service.searchMentions({ ...SEARCH, q: 'sam' })).toEqual([
      { userId: 'staff-1', username: 'Sam Support' },
    ]);
  });

  it('still returns offline players for a staff viewer', async () => {
    const service = makeMentionService({
      viewerRole: 'admin',
      onlineUserIds: [],
      findPlayerIds: ['offline-1'],
      players: [{ userId: 'offline-1', username: 'alice' }],
    });

    expect(await service.searchMentions({ ...SEARCH, q: 'ali' })).toEqual([
      { userId: 'offline-1', username: 'alice' },
    ]);
  });
});

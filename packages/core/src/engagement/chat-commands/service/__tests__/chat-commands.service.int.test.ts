import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../../testing/mock.js';
import type {
  AdminUserDirectory,
  AuditWritePort,
  ChatBlockReader,
  ChatRoomAccess,
  RealtimeTransport,
} from '@openora/core/contracts';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import { migrate } from '../../migrate.js';
import { chatCommandConfig } from '../../schema/index.js';
import { ChatCommandsService } from '../chat-commands.service.js';
import { ChatCommandDescriptorSchema } from '../../contract/index.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateChat, migrate]);
});

afterAll(() => db.drop());

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE chat_command_config`);
});

const ENABLED_ROW = {
  key: 'gift',
  enabled: true,
  label: 'Gift',
  description: null,
  config: null,
};
const DISABLED_ROW = { ...ENABLED_ROW, key: 'rain', label: 'Rain', enabled: false };

async function seed(...rows: (typeof chatCommandConfig.$inferInsert)[]) {
  await db.drizzle.db.insert(chatCommandConfig).values(rows);
}

function makeService() {
  return new ChatCommandsService(
    db.drizzle,
    mock<AdminUserDirectory>({
      findPlayerIds: vi.fn().mockResolvedValue([]),
      lookupPlayers: vi.fn().mockResolvedValue([]),
    }),
    mock<ChatBlockReader>({ getExcludedUserIds: vi.fn().mockResolvedValue([]) }),
    mock<RealtimeTransport>({ getOnlineUserIds: vi.fn().mockResolvedValue([]) }),
    mock<AuditWritePort>({ record: vi.fn().mockResolvedValue(undefined) }),
    mock<ChatRoomAccess>({ verifyRoomAccess: vi.fn().mockResolvedValue(undefined) }),
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
    db.drizzle,
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
    mock<ChatBlockReader>({
      getExcludedUserIds: vi.fn().mockResolvedValue(deps.excludedUserIds ?? []),
    }),
    mock<RealtimeTransport>({
      getOnlineUserIds: vi.fn().mockResolvedValue(deps.onlineUserIds ?? []),
    }),
    mock<AuditWritePort>({ record: vi.fn().mockResolvedValue(undefined) }),
    mock<ChatRoomAccess>({ verifyRoomAccess: vi.fn().mockResolvedValue(undefined) }),
  );
}

const SEARCH = { limit: 20, roomId: null, viewerId: 'viewer' } as const;

describe('ChatCommandsService command registry', () => {
  it('returns only enabled commands by default', async () => {
    await seed(ENABLED_ROW, DISABLED_ROW);

    const result = await makeService().listCommands();

    expect(result.map((c) => c.key)).toEqual(['gift']);
  });

  it('returns disabled commands for administrators', async () => {
    await seed(ENABLED_ROW, DISABLED_ROW);

    const result = await makeService().adminListCommands({
      page: 1,
      limit: 10,
      sortBy: 'key',
      sortOrder: 'asc',
    });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('emits a descriptor the route contract accepts for a single-currency limit', async () => {
    const config = { minAmount: { currency: 'USD', amount: '1.00000000' }, maxRecipients: 100 };
    await seed({ ...ENABLED_ROW, config });

    const result = await makeService().adminListCommands({
      page: 1,
      limit: 10,
      sortBy: 'key',
      sortOrder: 'asc',
    });

    expect(ChatCommandDescriptorSchema.parse(result.items[0]).config).toEqual(config);
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
      db.drizzle,
      mock<AdminUserDirectory>({
        findPlayerIds,
        lookupPlayers: vi.fn().mockResolvedValue([{ userId: 'wanted', username: 'dave' }]),
      }),
      mock<ChatBlockReader>({ getExcludedUserIds: vi.fn().mockResolvedValue(['blocked']) }),
      mock<RealtimeTransport>({ getOnlineUserIds: vi.fn().mockResolvedValue([]) }),
      mock<AuditWritePort>({ record: vi.fn().mockResolvedValue(undefined) }),
      mock<ChatRoomAccess>({ verifyRoomAccess: vi.fn().mockResolvedValue(undefined) }),
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

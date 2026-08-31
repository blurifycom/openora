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

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { call } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { tag, playerTag } from '@openora/core/pam/schema/tag';
import { migrate as migrateTag } from '@openora/core/pam/migrate/tag';
import type {
  AdminUserDirectory,
  AdminGameReporting,
  ChatBlockWriter,
  SessionCommands,
  UserCommands,
} from '@openora/core/contracts';
import {
  mock,
  makeAdminGuard,
  makeAuditWriter,
  makeEventBus,
  testContext,
} from '../../../testing/mock.js';
import { createPlayerRouter } from '../router/index.js';
import { PlayerService } from '../service/player.service.js';

const CTX = testContext();
const CALLER = '44444444-4444-4444-8444-444444444444';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrateTag]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tag}, ${player}, ${user} RESTART IDENTITY CASCADE`,
  );
});

const guardAllowing = (allow: readonly string[]) =>
  makeAdminGuard({ allow, caller: { userId: CALLER } });

function build(
  adminGuard: AdminGuard,
  overrides: {
    userDirectory?: AdminUserDirectory;
    gameReporting?: AdminGameReporting;
    blockWriter?: ChatBlockWriter;
  } = {},
) {
  const service = new PlayerService(
    db.drizzle,
    makeEventBus(),
    overrides.userDirectory ?? mock<AdminUserDirectory>({}),
    overrides.gameReporting ?? mock<AdminGameReporting>({}),
    overrides.blockWriter ?? mock<ChatBlockWriter>({}),
    mock<SessionCommands>({ revokeAll: vi.fn().mockResolvedValue({ success: true }) }),
    mock<UserCommands>({
      setUsername: vi.fn(async (userId: string, username: string) => {
        // Stands in for identity's USER_COMMANDS so the round-trip through the
        // enriched read still holds; the real port is covered in its own module.
        await db.drizzle.db.update(user).set({ username }).where(eq(user.id, userId));
        return { success: true };
      }),
    }),
  );
  const audit = makeAuditWriter();
  return { router: createPlayerRouter(service, adminGuard, audit), audit };
}

async function seedPlayer() {
  const [account] = await db.drizzle.db
    .insert(user)
    .values({
      name: 'Player',
      username: randomUUID().replaceAll('-', '').slice(0, 20),
      email: `${randomUUID()}@example.com`,
    })
    .returning();
  const [row] = await db.drizzle.db.insert(player).values({ userId: account!.id }).returning();
  return row!;
}

describe('player router update', () => {
  it('persists a non-KYC update with only player:update', async () => {
    const seeded = await seedPlayer();
    const { router } = build(guardAllowing(['player:update']));

    const result = await call(
      router.update,
      { playerId: seeded.id, username: 'new_player' },
      { context: CTX },
    );

    expect(result.username).toBe('new_player');
  });

  it('records an admin.player.updated audit entry with before/after snapshots', async () => {
    const seeded = await seedPlayer();
    const { router, audit } = build(guardAllowing(['player:update']));

    await call(router.update, { playerId: seeded.id, username: 'new_player' }, { context: CTX });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: CALLER,
        actorType: 'admin',
        action: 'admin.player.updated',
        resourceType: 'player',
        resourceId: seeded.id,
        before: expect.objectContaining({ username: expect.any(String) }),
        after: expect.objectContaining({ username: 'new_player' }),
      }),
    );
  });

  it('writes no audit entry when the guard rejects the caller', async () => {
    const seeded = await seedPlayer();
    const { router, audit } = build(guardAllowing([]));

    await expect(
      call(router.update, { playerId: seeded.id, username: 'new_player' }, { context: CTX }),
    ).rejects.toBeDefined();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('maps an unknown player to NOT_FOUND', async () => {
    const { router } = build(guardAllowing(['player:update']));

    await expect(
      call(router.update, { playerId: randomUUID(), username: 'new_player' }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// playerSearch/playerProfile are player-facing (no adminGuard call) - any
// authenticated caller can reach them, unlike every other route in this router.
describe('player router playerSearch / playerProfile', () => {
  const VIEWER = '55555555-5555-4555-8555-555555555555';
  const VIEWER_CTX = testContext({ auth: { userId: VIEWER } });

  it('rejects an unauthenticated caller with UNAUTHORIZED', async () => {
    const { router } = build(guardAllowing([]));

    await expect(
      call(router.playerSearch, { q: 'bob', limit: 10 }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('does not require the admin guard for an authenticated player', async () => {
    const userDirectory = mock<AdminUserDirectory>({
      findPlayerIds: async () => [],
      lookupPlayers: async () => [],
    });
    const { router } = build(guardAllowing([]), { userDirectory });

    await expect(
      call(router.playerSearch, { q: 'bob', limit: 10 }, { context: VIEWER_CTX }),
    ).resolves.toEqual([]);
  });

  it('maps an unknown profile userId to NOT_FOUND', async () => {
    const userDirectory = mock<AdminUserDirectory>({ lookupPlayers: async () => [] });
    const { router } = build(guardAllowing([]), { userDirectory });

    await expect(
      call(router.playerProfile, { userId: randomUUID() }, { context: VIEWER_CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

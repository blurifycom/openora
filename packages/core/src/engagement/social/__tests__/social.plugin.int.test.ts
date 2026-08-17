import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  Container,
  ModuleRegistryImpl,
  DRIZZLE,
  EVENT_BUS,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { IDENTITY_READER } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import { chatUserBlock } from '@openora/core/engagement/schema/chat';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeEventBus, makeIdentityReader } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { friendship } from '../schema/index.js';
import { SocialService } from '../service/social.service.js';
import socialPlugin from '../plugin.js';

// Exercises the ACTUAL plugin wiring (plugin.ts's register()), not just the service
// method - proves the 'chat.user.blocked' subscriber the plugin registers is the one
// that resolves to SocialService.dissolveFriendshipOnBlock, with the real event
// payload shape from domainEventSchemas.
let db: TestDb;

async function seedPlayer(overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId: randomUUID(), displayName: 'Player', ...overrides })
    .returning();
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateChat]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${friendship}, ${chatUserBlock}, ${player} RESTART IDENTITY CASCADE`,
  );
});

function boot() {
  const container = new Container<CoreTokenCatalog>();
  const events = makeEventBus();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => events);
  container.register(IDENTITY_READER, () => makeIdentityReader());
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);

  socialPlugin.register(registry);
  // Router factories run once, after every plugin has registered (create-app.ts boot
  // order) - this is what makes socialRef non-null before any real event arrives.
  registry.routers.getAll().get('social')?.(container);

  const chatUserBlockedHandlers = registry.events.getAll().get('chat.user.blocked') ?? [];
  return { events, chatUserBlockedHandlers };
}

async function makeFriends(alice: string, bob: string) {
  const eventsForSetup = makeEventBus();
  const svc = new SocialService(db.drizzle, eventsForSetup, makeIdentityReader());
  const first = await svc.sendFriendRequest(alice, bob);
  await svc.sendFriendRequest(bob, alice); // mutual auto-accept
  return first;
}

// The plugin's handler is intentionally fire-and-forget (matches notifications/tag
// plugin.ts's convention: `.catch(err => logger.error(...))`, never `return`ed), so
// it does not hand back a promise the test can await - poll for the effect instead.
async function waitUntil(
  fn: () => Promise<boolean>,
  { timeoutMs = 2000, intervalMs = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitUntil: condition never became true');
}

async function getFriendshipById(id: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(friendship)
    .where(sql`${friendship.id} = ${id}`);
  return row;
}

describe('social plugin chat.user.blocked wiring', () => {
  it('registers exactly one handler for chat.user.blocked', () => {
    const { chatUserBlockedHandlers } = boot();
    expect(chatUserBlockedHandlers).toHaveLength(1);
  });

  it('dissolves an active friendship when chat.user.blocked fires with the real payload shape', async () => {
    const { chatUserBlockedHandlers } = boot();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    const friendshipRow = await makeFriends(alice.userId, bob.userId);

    const handler = chatUserBlockedHandlers[0]!;
    handler({
      blockerId: alice.userId,
      actorPlayerId: null,
      blockedId: bob.userId,
      playerId: null,
    });

    await waitUntil(async () => (await getFriendshipById(friendshipRow.id))?.removedAt !== null);
    const row = await getFriendshipById(friendshipRow.id);
    expect(row?.removedAt).toBeInstanceOf(Date);
  });

  it('silently no-ops (never throws, never writes) when the pair has no active friendship', async () => {
    const { chatUserBlockedHandlers } = boot();
    const alice = await seedPlayer();
    const bob = await seedPlayer();

    const handler = chatUserBlockedHandlers[0]!;
    expect(() =>
      handler({
        blockerId: alice.userId,
        actorPlayerId: null,
        blockedId: bob.userId,
        playerId: null,
      }),
    ).not.toThrow();

    // Nothing to wait for (no row exists) - a short settle is enough to prove no
    // deferred write throws/crashes the process.
    await new Promise((r) => setTimeout(r, 50));
    expect(await db.drizzle.db.select().from(friendship)).toHaveLength(0);
  });

  it('ignores a malformed payload instead of throwing', () => {
    const { chatUserBlockedHandlers } = boot();
    const handler = chatUserBlockedHandlers[0]!;

    expect(() => handler({ nonsense: true })).not.toThrow();
  });
});

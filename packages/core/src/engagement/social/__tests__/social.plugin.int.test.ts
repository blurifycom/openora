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
import { IDENTITY_READER, SOCIAL_COMMANDS } from '@openora/core/contracts';
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
  registry.routers.getAll().get('social')?.(container);

  return { events, socialCommands: container.get(SOCIAL_COMMANDS) };
}

async function makeFriends(alice: string, bob: string) {
  const eventsForSetup = makeEventBus();
  const svc = new SocialService(db.drizzle, eventsForSetup, makeIdentityReader());
  const first = await svc.sendFriendRequest(alice, bob);
  await svc.sendFriendRequest(bob, alice); // mutual auto-accept
  return first;
}

async function getFriendshipById(id: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(friendship)
    .where(sql`${friendship.id} = ${id}`);
  return row;
}

describe('social plugin SOCIAL_COMMANDS wiring', () => {
  it('dissolves an active friendship on its own tx, before returning', async () => {
    const { socialCommands } = boot();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    const friendshipRow = await makeFriends(alice.userId, bob.userId);

    await db.drizzle.db.transaction((tx) =>
      socialCommands.dissolveFriendshipOnBlock(tx, alice.userId, bob.userId),
    );

    const row = await getFriendshipById(friendshipRow.id);
    expect(row?.removedAt).toBeInstanceOf(Date);
  });

  it('silently no-ops (never throws, never writes) when the pair has no active friendship', async () => {
    const { socialCommands } = boot();
    const alice = await seedPlayer();
    const bob = await seedPlayer();

    await expect(
      db.drizzle.db.transaction((tx) =>
        socialCommands.dissolveFriendshipOnBlock(tx, alice.userId, bob.userId),
      ),
    ).resolves.toBeNull();
    expect(await db.drizzle.db.select().from(friendship)).toHaveLength(0);
  });

  it('dissolveFriendshipOnBlock never emits by itself - it only returns the payload for the caller to emit after its own commit', async () => {
    const { socialCommands, events } = boot();
    const alice = await seedPlayer();
    const bob = await seedPlayer();
    const friendshipRow = await makeFriends(alice.userId, bob.userId);

    const dissolved = await db.drizzle.db.transaction((tx) =>
      socialCommands.dissolveFriendshipOnBlock(tx, alice.userId, bob.userId),
    );

    expect(dissolved).toMatchObject({ friendshipId: friendshipRow.id, reason: 'blocked' });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('still dissolves correctly when resolved before the social router is mounted', async () => {
    const container = new Container<CoreTokenCatalog>();
    const events = makeEventBus();
    container.register(DRIZZLE, () => db.drizzle);
    container.register(EVENT_BUS, () => events);
    container.register(IDENTITY_READER, () => makeIdentityReader());
    const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);

    socialPlugin.register(registry);
    // SOCIAL_COMMANDS resolved BEFORE the social router factory runs - mirrors
    // chat's plugin.ts resolving it in its own router factory, which may run
    // before or after social's, depending on plugin load order. Must not freeze
    // on a not-yet-constructed SocialService.
    const socialCommands = container.get(SOCIAL_COMMANDS);
    registry.routers.getAll().get('social')?.(container);

    const alice = await seedPlayer();
    const bob = await seedPlayer();
    const friendshipRow = await makeFriends(alice.userId, bob.userId);

    await db.drizzle.db.transaction((tx) =>
      socialCommands.dissolveFriendshipOnBlock(tx, alice.userId, bob.userId),
    );

    const row = await getFriendshipById(friendshipRow.id);
    expect(row?.removedAt).toBeInstanceOf(Date);
  });
});

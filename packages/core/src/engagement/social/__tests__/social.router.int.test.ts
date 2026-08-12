import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeEventBus, testContext } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { friendship, socialUserBlock } from '../schema/index.js';
import { createSocialRouter } from '../router/index.js';
import { SocialService } from '../service/social.service.js';

let db: TestDb;

function build() {
  const events = makeEventBus();
  return { router: createSocialRouter(new SocialService(db.drizzle, events)), events };
}

async function seedPlayer(overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId: randomUUID(), displayName: 'Player', ...overrides })
    .returning();
  return row!;
}

const ctxFor = (userId: string) => testContext({ auth: { userId } });

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${friendship}, ${socialUserBlock}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('social router authz', () => {
  it('rejects sendFriendRequest for an unauthenticated caller', async () => {
    const { router } = build();

    await expect(
      call(router.sendFriendRequest, { targetUserId: randomUUID() }, { context: testContext() }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects getRelationships for an unauthenticated caller', async () => {
    const { router } = build();

    await expect(
      call(router.getRelationships, { userIds: [randomUUID()] }, { context: testContext() }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe('social router sendFriendRequest', () => {
  it('sends a pending friend request for an authenticated caller', async () => {
    const { router } = build();
    const requester = await seedPlayer({ displayName: 'Alice' });
    const target = await seedPlayer({ displayName: 'Bob' });

    const result = await call(
      router.sendFriendRequest,
      { targetUserId: target.userId },
      { context: ctxFor(requester.userId) },
    );

    expect(result).toMatchObject({
      requesterId: requester.userId,
      addresseeId: target.userId,
      status: 'pending',
    });
  });

  it('maps a self-targeted request to BAD_REQUEST', async () => {
    const { router } = build();
    const p = await seedPlayer();

    const error: unknown = await call(
      router.sendFriendRequest,
      { targetUserId: p.userId },
      { context: ctxFor(p.userId) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<'sendFriendRequest', unknown>).code).toBe('BAD_REQUEST');
  });

  it('maps a nonexistent target to NOT_FOUND', async () => {
    const { router } = build();
    const requester = await seedPlayer();

    const error: unknown = await call(
      router.sendFriendRequest,
      { targetUserId: randomUUID() },
      { context: ctxFor(requester.userId) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<'sendFriendRequest', unknown>).code).toBe('NOT_FOUND');
  });

  it('maps a same-direction duplicate to CONFLICT', async () => {
    const { router } = build();
    const requester = await seedPlayer();
    const target = await seedPlayer();
    await call(
      router.sendFriendRequest,
      { targetUserId: target.userId },
      { context: ctxFor(requester.userId) },
    );

    const error: unknown = await call(
      router.sendFriendRequest,
      { targetUserId: target.userId },
      { context: ctxFor(requester.userId) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<'sendFriendRequest', unknown>).code).toBe('CONFLICT');
  });
});

describe('social router getRelationships', () => {
  it('returns a batch row per requested userId', async () => {
    const { router } = build();
    const caller = await seedPlayer();
    const a = await seedPlayer();
    const b = await seedPlayer();

    const result = await call(
      router.getRelationships,
      { userIds: [a.userId, b.userId] },
      { context: ctxFor(caller.userId) },
    );

    expect(result).toEqual([
      { userId: a.userId, status: 'none', friendshipId: null, canSendRequest: true },
      { userId: b.userId, status: 'none', friendshipId: null, canSendRequest: true },
    ]);
  });
});

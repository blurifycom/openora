import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, or } from 'drizzle-orm';
import { createSocialHarness, type SocialHarness } from '../../../testing/social-harness.js';
import { seedPlayerWithUser } from '../../../testing/seed-player.js';
import { friendship } from '../schema/index.js';
import { RequestAlreadyPendingError } from '../service/social.service.js';

let harness: SocialHarness;

beforeAll(async () => {
  harness = await createSocialHarness();
}, 120_000);

afterAll(async () => {
  await harness.testDb.drop();
}, 60_000);

const pairRows = (a: string, b: string) =>
  harness.testDb.drizzle.db
    .select()
    .from(friendship)
    .where(
      or(
        and(eq(friendship.requesterId, a), eq(friendship.addresseeId, b)),
        and(eq(friendship.requesterId, b), eq(friendship.addresseeId, a)),
      ),
    );

describe('concurrent friend requests', () => {
  it('two players sending requests to each other at once end with a single accepted friendship', async () => {
    const a = (await seedPlayerWithUser(harness.testDb)).account.id;
    const b = (await seedPlayerWithUser(harness.testDb)).account.id;

    const results = await Promise.allSettled([
      harness.social.sendFriendRequest(a, b),
      harness.social.sendFriendRequest(b, a),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await pairRows(a, b);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.acceptedAt).not.toBeNull();
    expect(rows[0]?.refusedAt).toBeNull();
    const accepted = harness.emitted.filter(
      ({ topic, payload }) =>
        topic === 'social.friend_request.accepted' &&
        typeof payload === 'object' &&
        payload !== null &&
        'friendshipId' in payload &&
        payload.friendshipId === rows[0]?.id,
    );
    expect(accepted).toHaveLength(1);
  });

  it('parallel duplicate requests create one row', async () => {
    const a = (await seedPlayerWithUser(harness.testDb)).account.id;
    const b = (await seedPlayerWithUser(harness.testDb)).account.id;

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => harness.social.sendFriendRequest(a, b)),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const reason of rejected) {
      expect(reason).toBeInstanceOf(RequestAlreadyPendingError);
    }
    const rows = await pairRows(a, b);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.acceptedAt).toBeNull();
  });
});

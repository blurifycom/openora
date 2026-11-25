import { inArray } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '@openora/core/pam/schema/identity';
import type {
  LedgerPlayEligibilityPort,
  PlayEligibilityPort,
  PlayEligibilityState,
} from '@openora/core/contracts';
import type { DrizzleService, DrizzleTx } from '@openora/core/server';
// oxlint-disable-next-line oss-boundaries/no-cross-core-domain -- test-only helper, wires the real reader like the suites do
import { IdentityReaderService } from '@openora/core/pam/server';

// The gamification suites seed the profile and identity tables and stub the RG answer; this
// LEDGER_PLAY_ELIGIBILITY reads those, so the suites keep their fixtures. The real projection is
// held to the same answers by `ledger-play-eligibility-parity.int.test.ts`.
export function ledgerEligibilityOver(
  drizzle: DrizzleService,
  isRestricted: PlayEligibilityPort['isRestricted'],
): LedgerPlayEligibilityPort {
  const blank = { rgBlockedUntil: null, isActive: true, banned: false, banExpires: null };
  return {
    isRestricted,
    checkPlay: async () => null,
    async stateOf(userId, tx) {
      const db = (tx as DrizzleTx | undefined) ?? drizzle.db;
      const query = db
        .select({ status: player.status })
        .from(player)
        .where(inArray(player.userId, [userId]));
      const [row] = tx ? await query.for('share') : await query;
      return {
        ...blank,
        rgBlocked: await isRestricted(userId, tx),
        status: row?.status ?? null,
      };
    },
    async statesOf(userIds) {
      const states = new Map<string, PlayEligibilityState>();
      if (userIds.length === 0) {
        return states;
      }
      const users = await drizzle.db
        .select({ id: user.id, rgBlocked: user.rgBlocked, rgBlockedUntil: user.rgBlockedUntil })
        .from(user)
        .where(inArray(user.id, [...userIds]));
      const players = await drizzle.db
        .select({ userId: player.userId, status: player.status })
        .from(player)
        .where(inArray(player.userId, [...userIds]));
      for (const row of users) {
        states.set(row.id, { ...blank, ...row, status: null });
      }
      for (const row of players) {
        const state = states.get(row.userId) ?? { ...blank, rgBlocked: false, status: null };
        states.set(row.userId, { ...state, status: row.status });
      }
      return states;
    },
  };
}

export const identityOver = (drizzle: DrizzleService) => new IdentityReaderService(drizzle);

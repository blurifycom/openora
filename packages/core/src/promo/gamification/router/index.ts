import { implement } from '@orpc/server';
import {
  RATE_LIMIT_KEYS,
  makeRateLimitKey,
  type RateLimiterAdapter,
  type RateLimitKey,
} from '@openora/core/contracts';
import {
  assertRateLimit,
  getUserId,
  mapErrors,
  type AdminGuard,
  type OssContext,
} from '@openora/core/server';
import { gamificationContract } from '../contract/index.js';
import {
  RankAdminService,
  RankConfigInvalidError,
  RankConfigNotSetError,
  RankLadderCurrencyHeldError,
  RankLadderInvalidError,
  RankLadderMismatchError,
  RankTierHeldError,
  RankTierKeyTakenError,
} from '../service/rank-admin.service.js';
import { RankLadderNotConfiguredError, RankService } from '../service/rank.service.js';
import { StreakAdminService } from '../service/streak-admin.service.js';
import { StreakConfigNotSetError, StreakService } from '../service/streak.service.js';
import {
  StreakMilestoneNotClaimableError,
  type StreakClaimOutcome,
  type StreakPayoutService,
} from '../service/streak-payout.service.js';
import { RaceNotFoundError, RaceService } from '../service/race.service.js';
import { PayoutRateUnavailableError } from '../shared/payout-currency.js';
import {
  RaceAdminService,
  RaceClosedError,
  RacePositionsInvalidError,
} from '../service/race-admin.service.js';
import { RankChallengeService } from '../service/rank-challenge.service.js';
import {
  RankChallengeAdminService,
  RankChallengeLadderCurrencyHeldError,
  RankChallengeLadderVersionConflictError,
} from '../service/rank-challenge-admin.service.js';
import {
  RakebackAccountBlockedError,
  RakebackBelowMinimumError,
  RakebackClaimConflictError,
  RakebackClaimRestrictedError,
  RakebackNothingToClaimError,
  type RakebackClaimService,
} from '../service/rakeback-claim.service.js';
import {
  RakebackAccrualNotFoundError,
  RakebackAccrualNotVoidableError,
  type RakebackAdminService,
} from '../service/rakeback-admin.service.js';

const RAKEBACK_CLAIM_RATE_LIMIT = { limit: 5, windowMs: 60_000 } as const;

export function createGamificationRouter({
  ranks,
  admin,
  streaks,
  streakPayouts,
  onStreakClaimed,
  streakAdmin,
  races,
  raceAdmin,
  rankChallenge,
  rankChallengeAdmin,
  rakebackClaims,
  rakebackAdmin,
  rateLimiter,
  adminGuard,
}: {
  ranks: RankService;
  admin: RankAdminService;
  streaks: StreakService;
  streakPayouts: StreakPayoutService;
  /** Runs after the claim's transaction has committed. */
  onStreakClaimed: (claimed: StreakClaimOutcome) => Promise<void>;
  streakAdmin: StreakAdminService;
  races: RaceService;
  raceAdmin: RaceAdminService;
  rankChallenge: RankChallengeService;
  rankChallengeAdmin: RankChallengeAdminService;
  rakebackClaims: RakebackClaimService;
  rakebackAdmin: RakebackAdminService;
  rateLimiter: RateLimiterAdapter<RateLimitKey> | undefined;
  adminGuard: AdminGuard;
}) {
  const os = implement(gamificationContract).$context<OssContext>();

  return os.router({
    ranks: {
      // No `getUserId`: this one is public, and must stay that way.
      ladder: os.ranks.ladder.handler(() =>
        mapErrors({ NOT_FOUND: RankLadderNotConfiguredError }, () => ranks.getLadder()),
      ),

      get: os.ranks.get.handler(({ context }) =>
        mapErrors({ NOT_FOUND: RankLadderNotConfiguredError }, () =>
          ranks.getForPlayer(getUserId(context)),
        ),
      ),

      // No `getUserId`: public, so a chat avatar can show another player's rank badge.
      lookup: os.ranks.lookup.handler(({ input }) => ranks.lookup([...new Set(input.userIds)])),

      // No `getUserId`: public, like `ladder`.
      players: os.ranks.players.handler(() => ranks.playersPerTier()),
    },

    streaks: {
      get: os.streaks.get.handler(({ context }) =>
        mapErrors({ NOT_FOUND: StreakConfigNotSetError }, () =>
          streaks.getForPlayer(getUserId(context)),
        ),
      ),

      claim: os.streaks.claim.handler(async ({ input, context }) => {
        const claimed = await mapErrors(
          {
            NOT_FOUND: StreakMilestoneNotClaimableError,
            SERVICE_UNAVAILABLE: PayoutRateUnavailableError,
          },
          () => streakPayouts.claim(getUserId(context), input.milestoneGrantId),
        );
        await onStreakClaimed(claimed);
        return { outcome: claimed.outcome };
      }),

      leaderboard: os.streaks.leaderboard.handler(({ context }) =>
        streaks.leaderboard(getUserId(context)),
      ),
    },

    races: {
      listActive: os.races.listActive.handler(() => races.listActive(new Date())),

      get: os.races.get.handler(({ input, context }) =>
        mapErrors({ NOT_FOUND: RaceNotFoundError }, () =>
          races.getForPlayer(input.raceId, getUserId(context)),
        ),
      ),
    },

    rankChallenge: {
      get: os.rankChallenge.get.handler(({ context }) =>
        rankChallenge.getForPlayer(getUserId(context)),
      ),

      // No `getUserId`: public, the same rule `ranks.ladder` follows.
      ladder: os.rankChallenge.ladder.handler(() => rankChallenge.getLadder()),
    },

    rakeback: {
      summary: os.rakeback.summary.handler(({ context }) =>
        rakebackClaims.summary(getUserId(context)),
      ),

      claim: os.rakeback.claim.handler(async ({ input, context }) => {
        const userId = getUserId(context);
        await assertRateLimit(
          rateLimiter,
          makeRateLimitKey(RATE_LIMIT_KEYS.RAKEBACK_CLAIM, userId),
          RAKEBACK_CLAIM_RATE_LIMIT,
        );
        const claimed = await mapErrors(
          {
            FORBIDDEN: [RakebackClaimRestrictedError, RakebackAccountBlockedError],
            CONFLICT: [
              RakebackNothingToClaimError,
              RakebackBelowMinimumError,
              RakebackClaimConflictError,
            ],
          },
          () => rakebackClaims.claim(userId, input.idempotencyKey),
        );
        return {
          claimId: claimed.claimId,
          paid: claimed.paid.map(({ currency, amount }) => ({ currency, amount })),
        };
      }),
    },

    admin: {
      rakeback: {
        listAccruals: os.admin.rakeback.listAccruals.handler(async ({ input, context }) => {
          await adminGuard.assert(context, 'bonus', 'view');
          return rakebackAdmin.listAccruals(input);
        }),

        playerSummary: os.admin.rakeback.playerSummary.handler(async ({ input, context }) => {
          await adminGuard.assert(context, 'bonus', 'view');
          return rakebackAdmin.playerSummary(input.userId);
        }),

        liability: os.admin.rakeback.liability.handler(async ({ context }) => {
          await adminGuard.assert(context, 'bonus', 'view');
          return rakebackAdmin.liability();
        }),

        // The same permission a manual balance adjustment needs.
        void: os.admin.rakeback.void.handler(async ({ input, context }) => {
          const { userId, ip, userAgent } = await adminGuard.assertSuperAdmin(context);
          return mapErrors(
            {
              NOT_FOUND: RakebackAccrualNotFoundError,
              CONFLICT: RakebackAccrualNotVoidableError,
            },
            () => rakebackAdmin.void(userId, input.accrualId, input.reason, { ip, userAgent }),
          );
        }),
      },

      streaks: {
        config: {
          get: os.admin.streaks.config.get.handler(async ({ context }) => {
            await adminGuard.assert(context, 'bonus', 'view');
            return mapErrors({ NOT_FOUND: StreakConfigNotSetError }, () => streakAdmin.getConfig());
          }),

          set: os.admin.streaks.config.set.handler(async ({ input, context }) => {
            const { userId } = await adminGuard.assert(context, 'bonus', 'update');
            return streakAdmin.setConfig(userId, input);
          }),
        },
      },

      ranks: {
        get: os.admin.ranks.get.handler(async ({ context }) => {
          await adminGuard.assert(context, 'bonus', 'view');
          return mapErrors({ NOT_FOUND: RankLadderNotConfiguredError }, () => admin.get());
        }),

        set: os.admin.ranks.set.handler(async ({ input, context }) => {
          const { userId } = await adminGuard.assert(context, 'bonus', 'update');
          return mapErrors(
            {
              BAD_REQUEST: [RankLadderMismatchError, RankLadderInvalidError],
              CONFLICT: [RankTierHeldError, RankLadderCurrencyHeldError, RankTierKeyTakenError],
              NOT_FOUND: RankLadderNotConfiguredError,
            },
            () => admin.set(userId, input),
          );
        }),

        config: {
          get: os.admin.ranks.config.get.handler(async ({ context }) => {
            await adminGuard.assert(context, 'bonus', 'view');
            return mapErrors({ NOT_FOUND: RankConfigNotSetError }, () => admin.getConfig());
          }),

          set: os.admin.ranks.config.set.handler(async ({ input, context }) => {
            const { userId } = await adminGuard.assert(context, 'bonus', 'update');
            return mapErrors({ BAD_REQUEST: RankConfigInvalidError }, () =>
              admin.setConfig(userId, input),
            );
          }),
        },
      },

      races: {
        list: os.admin.races.list.handler(async ({ context }) => {
          await adminGuard.assert(context, 'bonus', 'view');
          return raceAdmin.list();
        }),

        get: os.admin.races.get.handler(async ({ input, context }) => {
          await adminGuard.assert(context, 'bonus', 'view');
          return mapErrors({ NOT_FOUND: RaceNotFoundError }, () => raceAdmin.get(input.raceId));
        }),

        create: os.admin.races.create.handler(async ({ input, context }) => {
          const { userId } = await adminGuard.assert(context, 'bonus', 'update');
          return mapErrors({ BAD_REQUEST: RacePositionsInvalidError }, () =>
            raceAdmin.create(userId, input),
          );
        }),

        update: os.admin.races.update.handler(async ({ input, context }) => {
          const { userId } = await adminGuard.assert(context, 'bonus', 'update');
          return mapErrors(
            {
              BAD_REQUEST: RacePositionsInvalidError,
              CONFLICT: RaceClosedError,
              NOT_FOUND: RaceNotFoundError,
            },
            () => raceAdmin.update(userId, input),
          );
        }),
      },

      rankChallenge: {
        config: {
          get: os.admin.rankChallenge.config.get.handler(async ({ context }) => {
            await adminGuard.assert(context, 'bonus', 'view');
            return rankChallengeAdmin.getLadder();
          }),

          set: os.admin.rankChallenge.config.set.handler(async ({ input, context }) => {
            const { userId } = await adminGuard.assert(context, 'bonus', 'update');
            return mapErrors(
              {
                CONFLICT: [
                  RankChallengeLadderCurrencyHeldError,
                  RankChallengeLadderVersionConflictError,
                ],
              },
              () => rankChallengeAdmin.setLadder(userId, input),
            );
          }),
        },

        claims: {
          list: os.admin.rankChallenge.claims.list.handler(async ({ context }) => {
            await adminGuard.assert(context, 'bonus', 'view');
            return rankChallengeAdmin.listClaims();
          }),
        },

        fulfilment: {
          list: os.admin.rankChallenge.fulfilment.list.handler(async ({ context }) => {
            await adminGuard.assert(context, 'bonus', 'view');
            return rankChallengeAdmin.listFulfilmentQueue();
          }),

          markFulfilled: os.admin.rankChallenge.fulfilment.markFulfilled.handler(
            async ({ input, context }) => {
              const { userId } = await adminGuard.assert(context, 'bonus', 'update');
              return rankChallengeAdmin.markFulfilled(userId, input.tierId, input.note);
            },
          ),
        },
      },
    },
  });
}

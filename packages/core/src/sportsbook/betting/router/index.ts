import { implement } from '@orpc/server';
import { getUserId, mapErrors, type AdminGuard, type OssContext } from '@openora/core/server';
import { sportsbookAdminContract, sportsbookContract } from '../contract/index.js';
import {
  SportsbookAlignProviderError,
  SportsbookAlignRefusedError,
  SportsbookBetChangedError,
  type SportsbookAlignService,
} from '../service/align.service.js';
import {
  SportsbookBetNotFoundError,
  type SportsbookBetQueryService,
} from '../service/bet-query.service.js';
import {
  SportsbookConfigInvalidError,
  type SportsbookConfigService,
} from '../service/config.service.js';
import {
  SportsbookDebtClearedError,
  SportsbookDebtIdempotencyKeyReusedError,
  SportsbookDebtNotFoundError,
  SportsbookDebtNothingCollectedError,
  type SportsbookDebtService,
} from '../service/debt.service.js';
import {
  SportsbookFindingNotFoundError,
  SportsbookFindingResolvedError,
  type SportsbookFindingService,
} from '../service/finding.service.js';
import {
  SportsbookPlayerNotFoundError,
  type SportsbookRestrictionService,
} from '../service/restriction.service.js';
import {
  SportsbookCurrencyNotOfferedError,
  SportsbookGeoRestrictedError,
  SportsbookPlayerBlockedError,
  SportsbookProviderUnavailableError,
  SportsbookUnavailableError,
  type SportsbookSessionService,
} from '../service/session.service.js';

export type SportsbookRouterServices = {
  adminGuard: AdminGuard;
  align: SportsbookAlignService;
  bets: SportsbookBetQueryService;
  config: SportsbookConfigService;
  debts: SportsbookDebtService;
  findings: SportsbookFindingService;
  restrictions: SportsbookRestrictionService;
  sessions: SportsbookSessionService;
};

export function createSportsbookRouter({
  adminGuard,
  align,
  bets,
  config,
  debts,
  findings,
  restrictions,
  sessions,
}: SportsbookRouterServices) {
  const { issueSession, listBets, getBet } = sportsbookContract;
  const {
    adminListBets,
    adminGetBet,
    alignBet,
    getConfig,
    updateConfig,
    suspend,
    resume,
    getRestriction,
    playerSummary,
    restrictPlayer,
    liftRestriction,
    listFindings,
    resolveFinding,
    listDebts,
    collectDebt,
    writeOffDebt,
    promotionReport,
  } = sportsbookAdminContract;
  const os = implement({
    issueSession,
    listBets,
    getBet,
    adminListBets,
    adminGetBet,
    alignBet,
    getConfig,
    updateConfig,
    suspend,
    resume,
    getRestriction,
    playerSummary,
    restrictPlayer,
    liftRestriction,
    listFindings,
    resolveFinding,
    listDebts,
    collectDebt,
    writeOffDebt,
    promotionReport,
  }).$context<OssContext>();

  return os.router({
    issueSession: os.issueSession.handler(({ input, context }) =>
      mapErrors(
        {
          BAD_REQUEST: SportsbookCurrencyNotOfferedError,
          FORBIDDEN: [SportsbookGeoRestrictedError, SportsbookPlayerBlockedError],
          SERVICE_UNAVAILABLE: [SportsbookUnavailableError, SportsbookProviderUnavailableError],
        },
        () => sessions.issue(getUserId(context), input, context.clientMeta.ip),
      ),
    ),

    listBets: os.listBets.handler(({ input, context }) => bets.listOwn(getUserId(context), input)),

    getBet: os.getBet.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: SportsbookBetNotFoundError }, () =>
        bets.getOwn(getUserId(context), input.id),
      ),
    ),

    adminListBets: os.adminListBets.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'sportsbook', 'view');
      return bets.adminList(input);
    }),

    adminGetBet: os.adminGetBet.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'sportsbook', 'view');
      const bet = await mapErrors({ NOT_FOUND: SportsbookBetNotFoundError }, () =>
        bets.adminGet(input.id),
      );
      return { ...bet, providerStatusLookup: align.canLookUp(bet.provider) };
    }),

    alignBet: os.alignBet.handler(async ({ input, context }) => {
      const actor = await adminGuard.assert(context, 'sportsbook', 'configure');
      await adminGuard.assert(context, 'transaction', 'refund');
      return mapErrors(
        {
          NOT_FOUND: SportsbookBetNotFoundError,
          CONFLICT: [
            SportsbookAlignProviderError,
            SportsbookAlignRefusedError,
            SportsbookBetChangedError,
          ],
          SERVICE_UNAVAILABLE: SportsbookProviderUnavailableError,
        },
        () => align.align(input.id, actor),
      );
    }),

    getConfig: os.getConfig.handler(async ({ context }) => {
      await adminGuard.assert(context, 'sportsbook', 'view');
      return config.get();
    }),

    updateConfig: os.updateConfig.handler(async ({ input, context }) => {
      const actor = await adminGuard.assert(context, 'sportsbook', 'configure');
      return mapErrors({ BAD_REQUEST: SportsbookConfigInvalidError }, () =>
        config.update(input, actor),
      );
    }),

    suspend: os.suspend.handler(async ({ input, context }) => {
      const actor = await adminGuard.assert(context, 'sportsbook', 'suspend');
      return config.setSuspended(true, input.reason, actor);
    }),

    resume: os.resume.handler(async ({ input, context }) => {
      const actor = await adminGuard.assert(context, 'sportsbook', 'suspend');
      return config.setSuspended(false, input.reason, actor);
    }),

    getRestriction: os.getRestriction.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'sportsbook', 'view');
      return mapErrors({ NOT_FOUND: SportsbookPlayerNotFoundError }, () =>
        restrictions.get(input.userId),
      );
    }),

    playerSummary: os.playerSummary.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'sportsbook', 'view');
      return mapErrors({ NOT_FOUND: SportsbookPlayerNotFoundError }, () =>
        bets.playerSummary(input),
      );
    }),

    restrictPlayer: os.restrictPlayer.handler(async ({ input, context }) => {
      const actor = await adminGuard.assert(context, 'sportsbook', 'suspend');
      return mapErrors({ NOT_FOUND: SportsbookPlayerNotFoundError }, () =>
        restrictions.restrict(input.userId, input.reason, actor),
      );
    }),

    liftRestriction: os.liftRestriction.handler(async ({ input, context }) => {
      const actor = await adminGuard.assert(context, 'sportsbook', 'suspend');
      return mapErrors({ NOT_FOUND: SportsbookPlayerNotFoundError }, () =>
        restrictions.lift(input.userId, input.reason, actor),
      );
    }),

    listFindings: os.listFindings.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'sportsbook', 'view');
      return findings.list(input);
    }),

    resolveFinding: os.resolveFinding.handler(async ({ input, context }) => {
      const actor = await adminGuard.assert(context, 'sportsbook', 'configure');
      await adminGuard.assert(context, 'transaction', 'refund');
      return mapErrors(
        { NOT_FOUND: SportsbookFindingNotFoundError, CONFLICT: SportsbookFindingResolvedError },
        () => findings.resolve(input.id, input.note, actor),
      );
    }),

    listDebts: os.listDebts.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'sportsbook', 'view');
      return debts.list(input);
    }),

    collectDebt: os.collectDebt.handler(async ({ input, context }) => {
      const actor = await adminGuard.assert(context, 'sportsbook', 'configure');
      await adminGuard.assert(context, 'transaction', 'refund');
      return mapErrors(
        {
          NOT_FOUND: SportsbookDebtNotFoundError,
          CONFLICT: [
            SportsbookDebtClearedError,
            SportsbookDebtNothingCollectedError,
            SportsbookDebtIdempotencyKeyReusedError,
          ],
        },
        () => debts.collect(input.id, input, actor),
      );
    }),

    writeOffDebt: os.writeOffDebt.handler(async ({ input, context }) => {
      const actor = await adminGuard.assert(context, 'sportsbook', 'configure');
      await adminGuard.assert(context, 'transaction', 'refund');
      return mapErrors(
        {
          NOT_FOUND: SportsbookDebtNotFoundError,
          CONFLICT: [SportsbookDebtClearedError, SportsbookDebtIdempotencyKeyReusedError],
        },
        () => debts.writeOff(input.id, input, actor),
      );
    }),

    promotionReport: os.promotionReport.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'sportsbook', 'view');
      return bets.promotionReport(input);
    }),
  });
}

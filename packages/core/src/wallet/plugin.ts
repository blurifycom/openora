import {
  ADMIN_GUARD,
  EVENT_BUS,
  DRIZZLE,
  createLogger,
  envMs,
  parseInternalCallers,
} from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import * as z from 'zod';
import {
  ADMIN_USER_DIRECTORY,
  BONUS_GRANTS,
  BONUS_GRANT_LEDGER,
  BONUS_DEPOSITS,
  BONUS_FUND_LOCKS,
  BONUS_LIFECYCLE,
  BONUS_WAGERING,
  IDENTITY_READER,
  ADMIN_WALLET_REPORTING,
  PAYMENT_ADAPTER,
  PAYMENT_WEBHOOK_VERIFIER,
  PAYMENT_PROVIDERS,
  DEFAULT_PAYMENT_PROVIDER,
  REALTIME_TRANSPORT,
  WALLET_COMMANDS,
  WALLET_READER,
  LEDGER_API_V1,
  LEDGER_PLAY_ELIGIBILITY,
  PLAY_ELIGIBILITY_PROJECTION,
  PLAY_ELIGIBILITY_SOURCE,
  GAMING_COMMANDS,
  SPORTSBOOK_LEDGER,
  WALLET_ASSET_CATALOG,
  PLATFORM_CONFIG,
  RATE_LIMITER,
  PLAYER_TAGS,
  PLAYER_SEGMENT_READER,
  PLAY_ELIGIBILITY,
  RG_LIMITS,
  RG_LIMIT_LEDGER,
  RG_LIMITS_SOURCE,
  MESSAGE_BROKER,
  DEPOSIT_ADMISSION_POLICY,
  DEPOSIT_HOLD_POLICY,
  KYC_WITHDRAWAL_POLICY,
  WITHDRAWAL_SECURITY,
  MAIL_DISPATCH,
  EXCHANGE_RATE_READER,
  resolveExchangeRatePivot,
  resolveWalletTurnoverConfig,
  SWAP_ADAPTER,
  SWAP_WEBHOOK_VERIFIER,
  ON_RAMP_ADAPTER,
  ON_RAMP_WEBHOOK_VERIFIER,
  GEO_CHECK_COMMANDS,
  CACHE,
  AUDIT_WRITER,
  JOB_QUEUE,
  McpToolError,
  UuidSchema,
  domainEventSchemas,
  queue,
  runActorAdminId,
  userIdOfPlayer,
  type RealtimeTransport,
  MONEY_REPORTING,
} from '@openora/core/contracts';
import {
  holdWithdrawalAction,
  playersDepositCompareTool,
  transactionsFindTool,
  walletActivityTool,
  withdrawalsQueueTool,
  type WalletBalanceChangeReason,
} from './contract/index.js';
import {
  WalletService,
  WithdrawalNotFoundError,
  WithdrawalNotPendingError,
  requireBonusFundLocks,
} from './service/wallet.service.js';
import {
  WalletCommandsService,
  cashTransferKindsWithoutTurnover,
} from './service/wallet-commands.service.js';
import { LedgerApiService } from './service/ledger-api.service.js';
import { LedgerRgLimitsService } from './service/ledger-rg-limits.service.js';
import { LedgerPlayEligibilityService } from './service/ledger-play-eligibility.service.js';
import { DepositCompareService, SegmentTooLargeError } from './service/deposit-compare.service.js';
import { TransactionsFindService } from './service/transactions-find.service.js';
import {
  CustodySweepService,
  CUSTODY_SWEEP_QUEUE,
  CustodySweepJobPayloadSchema,
} from './service/custody-sweep.service.js';
import { WalletReaderService } from './adapters/wallet-reader.service.js';
import { WalletAssetCatalogService } from './adapters/wallet-asset-catalog.service.js';
import { DrizzleAdminWalletReporting } from './admin-reporting.js';
import { MoneyReportingService } from './service/money-reporting.service.js';
import { createWalletRouter, walletBalanceChannel } from './router/index.js';
import { createInternalMoneyPortsRouter } from './router/internal-money-ports.router.js';
import { MockPaymentAdapter } from './adapters/mock/mock-payment-adapter.js';
import { HmacPaymentWebhookVerifier } from './adapters/hmac-payment-webhook-verifier.js';
import {
  LEDGER_INVARIANT_QUEUE,
  LedgerInvariantJobSchema,
  ReconciliationService,
  projectionDriftCheck,
} from './service/reconciliation.service.js';
import { SwapService } from './service/swap.service.js';
import {
  TURNOVER_PRICING_QUEUE,
  TurnoverPricingJobSchema,
  TurnoverService,
} from './service/turnover.service.js';
import { OnRampService } from './service/on-ramp.service.js';

const logger = createLogger('wallet');

const DEFAULT_SWEEP_CRON = '*/15 * * * *';

const WALLET_RECONCILIATION_QUEUE = queue('wallet-reconciliation');
const WalletReconciliationJobSchema = z.object({ runId: UuidSchema.optional() });
const DEFAULT_LEDGER_INVARIANT_CRON = '30 3 * * *';

function depositCompareRefusal(err: unknown): never {
  if (err instanceof SegmentTooLargeError) {
    throw new McpToolError('segment_too_large');
  }
  throw err;
}

function holdRefusalCode(err: unknown) {
  if (err instanceof WithdrawalNotFoundError) {
    return 'withdrawal_not_found';
  }
  if (err instanceof WithdrawalNotPendingError) {
    return 'withdrawal_not_pending';
  }
  throw err;
}

export default {
  id: 'wallet',
  dependsOn: ['identity', 'audit'],
  requiresPorts: [WITHDRAWAL_SECURITY, PLAYER_TAGS, KYC_WITHDRAWAL_POLICY],
  optionalPorts: [
    {
      port: PLAY_ELIGIBILITY_SOURCE,
      without: 'reconciliation never compares the play eligibility projection with identity',
    },
    {
      port: RG_LIMITS_SOURCE,
      without: 'reconciliation never compares the limits projection with compliance',
    },
    {
      port: BONUS_FUND_LOCKS,
      without:
        "no bonus locks real money and a withdrawal forfeits only through BONUS_LIFECYCLE; 'block' mode fails the boot",
    },
  ],
  register(ctx) {
    let reconciliationRef: ReconciliationService | null = null;

    let realtimeTransport: RealtimeTransport | null = null;
    let playEligibility: LedgerPlayEligibilityService | null = null;
    const moneyPortsCallers = parseInternalCallers(process.env['MONEY_PORTS_CALLERS']);
    const remoteWriter = () => moneyPortsCallers.size > 0;
    const staleMs = envMs('LEDGER_PROJECTION_STALE_MS', 60_000);
    const alertMs = envMs('LEDGER_PROJECTION_ALERT_MS', 30_000);
    if (alertMs >= staleMs) {
      throw new Error(
        `LEDGER_PROJECTION_ALERT_MS (${alertMs}) must be below LEDGER_PROJECTION_STALE_MS (${staleMs})`,
      );
    }
    const sharedPlayEligibility = (c: TypedContainer<CoreTokenCatalog>) =>
      (playEligibility ??= new LedgerPlayEligibilityService(c.get(DRIZZLE), {
        remoteWriter,
        staleMs,
        alertMs,
      }));
    let rgLimitsRef: LedgerRgLimitsService | null = null;
    const sharedRgLimits = (c: TypedContainer<CoreTokenCatalog>) =>
      (rgLimitsRef ??= new LedgerRgLimitsService(
        c.get(DRIZZLE),
        c.has(EXCHANGE_RATE_READER) ? c.get(EXCHANGE_RATE_READER) : undefined,
        { remoteWriter, staleMs, alertMs },
      ));

    const publishBalanceChanged = (
      userId: string,
      currency: string,
      reason: WalletBalanceChangeReason,
      eventId: string,
    ) => {
      if (!realtimeTransport) {
        return;
      }
      return realtimeTransport.publish(walletBalanceChannel(userId), {
        eventId,
        currency,
        reason,
      });
    };

    ctx.events.on('wallet.deposit.completed', (payload, envelope) => {
      const parsed = domainEventSchemas['wallet.deposit.completed'].safeParse(payload);
      if (!parsed.success || !envelope) {
        return;
      }
      return publishBalanceChanged(
        parsed.data.userId,
        parsed.data.currency,
        'deposit',
        envelope.eventId,
      );
    });
    ctx.events.on('wallet.withdrawal.requested', (payload, envelope) => {
      const parsed = domainEventSchemas['wallet.withdrawal.requested'].safeParse(payload);
      if (!parsed.success || !envelope) {
        return;
      }
      return publishBalanceChanged(
        parsed.data.userId,
        parsed.data.currency,
        'withdrawal',
        envelope.eventId,
      );
    });
    ctx.events.on('tag.withdrawal.screened', async (payload) => {
      const parsed = domainEventSchemas['tag.withdrawal.screened'].safeParse(payload);
      if (!parsed.success) {
        logger.error({ issues: parsed.error.issues }, 'malformed tag.withdrawal.screened dropped');
        return;
      }
      if (!walletSvc) {
        throw new Error('wallet service not constructed');
      }
      await walletSvc.autoApproveScreenedWithdrawal(parsed.data);
    });
    ctx.events.on('wallet.withdrawal.failed', (payload, envelope) => {
      const parsed = domainEventSchemas['wallet.withdrawal.failed'].safeParse(payload);
      if (!parsed.success || !envelope) {
        return;
      }
      return publishBalanceChanged(
        parsed.data.userId,
        parsed.data.currency,
        'withdrawal',
        envelope.eventId,
      );
    });
    ctx.events.on('wallet.withdrawal.rejected', (payload, envelope) => {
      const parsed = domainEventSchemas['wallet.withdrawal.rejected'].safeParse(payload);
      if (!parsed.success || !envelope) {
        return;
      }
      return publishBalanceChanged(
        parsed.data.userId,
        parsed.data.currency,
        'withdrawal',
        envelope.eventId,
      );
    });
    ctx.events.on('wallet.swap.completed', (payload, envelope) => {
      const parsed = domainEventSchemas['wallet.swap.completed'].safeParse(payload);
      if (!parsed.success || !envelope) {
        return;
      }
      return Promise.all([
        publishBalanceChanged(
          parsed.data.userId,
          parsed.data.fromCurrency,
          'swap',
          envelope.eventId,
        ),
        publishBalanceChanged(parsed.data.userId, parsed.data.toCurrency, 'swap', envelope.eventId),
      ]).then(() => undefined);
    });
    ctx.events.on('wallet.manual_adjustment.created', (payload, envelope) => {
      const parsed = domainEventSchemas['wallet.manual_adjustment.created'].safeParse(payload);
      if (!parsed.success || !envelope) {
        return;
      }
      return publishBalanceChanged(
        parsed.data.userId,
        parsed.data.currency,
        'adjustment',
        envelope.eventId,
      );
    });
    ctx.events.on('identity.play_eligibility.changed', async (payload) => {
      if (!playEligibility) {
        throw new Error('wallet: play eligibility projection not constructed yet');
      }
      const snapshot = domainEventSchemas['identity.play_eligibility.changed'].parse(payload);
      await playEligibility.reconcile([snapshot]);
    });
    ctx.events.on('compliance.rg_limits.changed', async (payload) => {
      if (!rgLimitsRef) {
        throw new Error('wallet: limits projection not constructed yet');
      }
      const parsed = domainEventSchemas['compliance.rg_limits.changed'].safeParse(payload);
      if (!parsed.success) {
        logger.error({ issues: parsed.error.issues }, 'wallet: invalid rg limits snapshot dropped');
        return;
      }
      await rgLimitsRef.reconcile([parsed.data]);
    });
    ctx.events.on('wallet.balance.changed', (payload, envelope) => {
      const parsed = domainEventSchemas['wallet.balance.changed'].safeParse(payload);
      if (!parsed.success || !envelope) {
        return;
      }
      return publishBalanceChanged(
        parsed.data.userId,
        parsed.data.currency,
        'gameplay',
        envelope.eventId,
      );
    });

    let sweepSvc: CustodySweepService | null = null;
    const custodySweepService = (c: TypedContainer<CoreTokenCatalog>) =>
      (sweepSvc ??= new CustodySweepService({
        drizzle: c.get(DRIZZLE),
        paymentProviders: c.get(PAYMENT_PROVIDERS),
        audit: c.get(AUDIT_WRITER),
        platformConfig: c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined,
      }));

    const bonusFundLocks = (c: TypedContainer<CoreTokenCatalog>) =>
      requireBonusFundLocks(
        c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined,
        c.has(BONUS_FUND_LOCKS) ? c.get(BONUS_FUND_LOCKS) : undefined,
      );

    let turnoverSvc: TurnoverService | null = null;
    const turnoverService = (c: TypedContainer<CoreTokenCatalog>) => {
      const platformConfig = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
      return (turnoverSvc ??= new TurnoverService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        audit: c.get(AUDIT_WRITER),
        config: resolveWalletTurnoverConfig(platformConfig?.wallet),
        pivotCurrency: resolveExchangeRatePivot(platformConfig?.exchangeRate),
        rates: c.has(EXCHANGE_RATE_READER) ? c.get(EXCHANGE_RATE_READER) : undefined,
      }));
    };

    let walletSvc: WalletService | null = null;
    const walletService = (c: TypedContainer<CoreTokenCatalog>) =>
      (walletSvc ??= new WalletService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        payment: c.get(PAYMENT_ADAPTER),
        paymentProviders: c.get(PAYMENT_PROVIDERS),
        identityReader: c.get(IDENTITY_READER),
        directory: c.get(ADMIN_USER_DIRECTORY),
        platformConfig: c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined,
        limiter: c.get(RATE_LIMITER),
        riskTags: c.get(PLAYER_TAGS),
        audit: c.get(AUDIT_WRITER),
        rgLimits: c.get(RG_LIMITS),
        rates: c.has(EXCHANGE_RATE_READER) ? c.get(EXCHANGE_RATE_READER) : undefined,
        kycPolicy: c.get(KYC_WITHDRAWAL_POLICY),
        withdrawalSecurity: c.get(WITHDRAWAL_SECURITY),
        mailDispatch: c.has(MAIL_DISPATCH) ? c.get(MAIL_DISPATCH) : undefined,
        depositHold: c.has(DEPOSIT_HOLD_POLICY) ? c.get(DEPOSIT_HOLD_POLICY) : undefined,
        depositAdmission: c.has(DEPOSIT_ADMISSION_POLICY)
          ? c.get(DEPOSIT_ADMISSION_POLICY)
          : undefined,
        playEligibility: c.get(PLAY_ELIGIBILITY),
        grantLedger: c.has(BONUS_GRANT_LEDGER) ? c.get(BONUS_GRANT_LEDGER) : undefined,
        bonusFundLocks: bonusFundLocks(c),
        bonusLifecycle: c.has(BONUS_LIFECYCLE) ? c.get(BONUS_LIFECYCLE) : undefined,
        depositBonus: c.has(BONUS_DEPOSITS) ? c.get(BONUS_DEPOSITS) : undefined,
        turnover: turnoverService(c),
      }));

    ctx.mcp.tool(walletActivityTool, (c) => {
      const identity = c.get(IDENTITY_READER);
      if (!identity.getUserIdByPlayerId) {
        logger.warn(
          'the bound IDENTITY_READER has no getUserIdByPlayerId - wallet.activity and hold_withdrawal will answer internal_error',
        );
      }
      const wallet = walletService(c);
      return async ({ playerId, windowDays }) => {
        const userId = await userIdOfPlayer(identity, playerId);
        if (!userId) {
          throw new McpToolError('player_not_found');
        }
        return { playerId, ...(await wallet.getActivity({ userId, windowDays })) };
      };
    });

    ctx.mcp.tool(withdrawalsQueueTool, (c) => {
      const wallet = walletService(c);
      return (input) => wallet.withdrawalQueueOverview(input);
    });

    ctx.mcp.tool(transactionsFindTool, (c) => {
      const transactions = new TransactionsFindService(c.get(DRIZZLE), c.get(IDENTITY_READER));
      return (input) => transactions.find(input);
    });

    ctx.mcp.tool(playersDepositCompareTool, (c) => {
      const identity = c.get(IDENTITY_READER);
      if (!identity.getUserIdsByPlayerIds) {
        logger.warn(
          'the bound IDENTITY_READER has no getUserIdsByPlayerIds - players.deposit_compare will answer internal_error',
        );
      }
      if (!c.has(PLAYER_SEGMENT_READER)) {
        logger.warn(
          'no PLAYER_SEGMENT_READER is bound (the tag module binds it) - players.deposit_compare will answer internal_error',
        );
        return async () => {
          throw new Error('players.deposit_compare needs a bound PLAYER_SEGMENT_READER');
        };
      }
      const deposits = new DepositCompareService({
        drizzle: c.get(DRIZZLE),
        segments: c.get(PLAYER_SEGMENT_READER),
        identity,
        rates: c.has(EXCHANGE_RATE_READER) ? c.get(EXCHANGE_RATE_READER) : undefined,
        pivotCurrency: resolveExchangeRatePivot(
          c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).exchangeRate : undefined,
        ),
      });
      return (input) => deposits.compare(input).catch(depositCompareRefusal);
    });

    ctx.actions.register(holdWithdrawalAction, (c) => {
      const identity = c.get(IDENTITY_READER);
      const wallet = walletService(c);
      return {
        precondition: async ({ playerId, withdrawalId }) => {
          const userId = await userIdOfPlayer(identity, playerId);
          if (!userId) {
            return { ok: false, code: 'player_not_found' };
          }
          const status = await wallet.getPlayerWithdrawalStatus({ userId, withdrawalId });
          if (status === null) {
            return { ok: false, code: 'withdrawal_not_found' };
          }
          if (status !== 'pending') {
            return { ok: false, code: 'withdrawal_not_pending' };
          }
          return { ok: true };
        },
        execute: async ({ playerId, withdrawalId, reason }, proposalId, actor) => {
          const userId = await userIdOfPlayer(identity, playerId);
          if (!userId) {
            throw new McpToolError('player_not_found');
          }
          const { changed } = await wallet
            .holdWithdrawal({
              adminId: runActorAdminId(actor),
              userId,
              withdrawalId,
              reason,
              proposalId,
            })
            .catch((err: unknown) => {
              throw new McpToolError(holdRefusalCode(err));
            });
          return { outcome: changed ? 'applied' : 'already_applied' };
        },
      };
    });

    ctx.jobs.worker({
      queue: CUSTODY_SWEEP_QUEUE,
      schema: CustodySweepJobPayloadSchema,
      handler: async ({ payload }) => {
        if (!sweepSvc) {
          throw new Error('wallet custody sweep: service not constructed yet');
        }
        await sweepSvc.runCycle(payload.runId);
      },
    });

    ctx.jobs.worker({
      queue: WALLET_RECONCILIATION_QUEUE,
      schema: WalletReconciliationJobSchema,
      handler: async ({ payload }) => {
        if (!reconciliationRef) {
          throw new Error('wallet reconciliation: service not constructed yet');
        }
        await reconciliationRef.runCycle(payload.runId);
      },
    });

    ctx.jobs.worker({
      queue: LEDGER_INVARIANT_QUEUE,
      schema: LedgerInvariantJobSchema,
      handler: async ({ payload }) => {
        if (!reconciliationRef) {
          throw new Error('wallet ledger invariant: service not constructed yet');
        }
        await reconciliationRef.runLedgerInvariant(payload.runId, {
          backfillBaselines: payload.backfillBaselines,
        });
      },
    });

    ctx.jobs.worker({
      queue: TURNOVER_PRICING_QUEUE,
      schema: TurnoverPricingJobSchema,
      handler: async () => {
        if (!turnoverSvc) {
          throw new Error('wallet turnover pricing: service not constructed yet');
        }
        await turnoverSvc.priceAllPending();
      },
    });

    ctx.provide(PAYMENT_ADAPTER, () => new MockPaymentAdapter());
    ctx.provide(PAYMENT_WEBHOOK_VERIFIER, () => {
      const webhookSecret = z
        .string()
        .min(1)
        .optional()
        .parse(process.env.PAYMENT_WEBHOOK_SECRET || undefined);
      return new HmacPaymentWebhookVerifier(webhookSecret);
    });
    ctx.provide(PAYMENT_PROVIDERS, (c) => ({
      get: (name: string) =>
        name === DEFAULT_PAYMENT_PROVIDER
          ? { adapter: c.get(PAYMENT_ADAPTER), webhookVerifier: c.get(PAYMENT_WEBHOOK_VERIFIER) }
          : null,
      names: () => [DEFAULT_PAYMENT_PROVIDER],
    }));
    ctx.provideSealed(LEDGER_PLAY_ELIGIBILITY, sharedPlayEligibility);
    ctx.provideSealed(PLAY_ELIGIBILITY_PROJECTION, sharedPlayEligibility);
    ctx.provideSealed(RG_LIMITS, sharedRgLimits);
    ctx.provideSealed(RG_LIMIT_LEDGER, sharedRgLimits);
    ctx.provide(
      WALLET_COMMANDS,
      (c) =>
        new WalletCommandsService(c.get(LEDGER_PLAY_ELIGIBILITY), c.get(AUDIT_WRITER), {
          platformConfig: c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined,
          rgLimits: c.get(RG_LIMITS),
          bonusWagering: c.has(BONUS_WAGERING) ? c.get(BONUS_WAGERING) : undefined,
          bonusGrants: c.has(BONUS_GRANTS) ? c.get(BONUS_GRANTS) : undefined,
          bonusFundLocks: bonusFundLocks(c),
          identityReader: c.get(IDENTITY_READER),
          turnover: () => turnoverService(c),
        }),
    );
    ctx.provide(
      LEDGER_API_V1,
      (c) =>
        new LedgerApiService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          walletCommands: c.get(WALLET_COMMANDS),
          identityReader: c.get(IDENTITY_READER),
          gamingCommands: () => c.get(GAMING_COMMANDS),
          sportsbookLedger: () => c.get(SPORTSBOOK_LEDGER),
        }),
    );
    ctx.provide(
      WALLET_READER,
      (c) =>
        new WalletReaderService({
          drizzle: c.get(DRIZZLE),
          defaultCurrency: c.has(PLATFORM_CONFIG)
            ? c.get(PLATFORM_CONFIG).wallet?.defaultCurrency
            : undefined,
          exchangeRateReader: c.has(EXCHANGE_RATE_READER) ? c.get(EXCHANGE_RATE_READER) : undefined,
          pivotCurrency: resolveExchangeRatePivot(
            c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG).exchangeRate : undefined,
          ),
          turnover: () => turnoverService(c),
        }),
    );
    ctx.provide(ADMIN_WALLET_REPORTING, (c) => new DrizzleAdminWalletReporting(c.get(DRIZZLE)));
    ctx.provide(MONEY_REPORTING, (c) => new MoneyReportingService(c.get(DRIZZLE)));
    ctx.provide(WALLET_ASSET_CATALOG, (c) => new WalletAssetCatalogService(c.get(DRIZZLE)));
    ctx.routers.addInternal('money', (c) =>
      createInternalMoneyPortsRouter(
        (token) => c.get(token as CoreTokenCatalog[keyof CoreTokenCatalog]),
        c.get(DRIZZLE).db,
        moneyPortsCallers,
      ),
    );
    ctx.routers.add('wallet', (c, options) => {
      realtimeTransport = c.get(REALTIME_TRANSPORT);
      sharedPlayEligibility(c);
      const rgLimits = sharedRgLimits(c);
      const platformConfig = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
      if (Object.keys(platformConfig?.wallet?.significantAmountThresholds ?? {}).length === 0) {
        logger.warn(
          'wallet.significantAmountThresholds is not configured - large bets and wins are not audited',
        );
      }
      const untracked = cashTransferKindsWithoutTurnover(platformConfig?.wallet);
      if (untracked.length > 0) {
        logger.warn(
          { kinds: untracked },
          'wallet.transferCredits is cash but these transfer kinds carry no turnover requirement - a received transfer can be withdrawn at once',
        );
      }
      const wallet = walletService(c);

      const reconciliation = new ReconciliationService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        wallet,
        paymentProviders: c.get(PAYMENT_PROVIDERS),
        audit: c.get(AUDIT_WRITER),
        platformConfig,
        rgLimits,
        projectionChecks: [
          ...(c.has(PLAY_ELIGIBILITY_SOURCE)
            ? [
                projectionDriftCheck(
                  'play_eligibility_drift',
                  c.get(PLAY_ELIGIBILITY_SOURCE),
                  sharedPlayEligibility(c),
                ),
              ]
            : []),
          ...(c.has(RG_LIMITS_SOURCE)
            ? [projectionDriftCheck('rg_limits_drift', c.get(RG_LIMITS_SOURCE), rgLimits)]
            : []),
        ],
        broker: c.has(MESSAGE_BROKER) ? c.get(MESSAGE_BROKER) : undefined,
      });
      reconciliationRef = reconciliation;

      const jobQueue = c.get(JOB_QUEUE);

      custodySweepService(c);
      if (options?.mounted !== false) {
        const sweepCron = platformConfig?.wallet?.sweep?.cron ?? DEFAULT_SWEEP_CRON;
        void jobQueue
          .schedule(CUSTODY_SWEEP_QUEUE, 'wallet-custody-sweep.cron', {}, { cron: sweepCron })
          .catch((err) => logger.error({ err }, 'wallet-custody-sweep schedule failed'));

        if (platformConfig?.wallet?.reconciliation) {
          void jobQueue
            .schedule(
              WALLET_RECONCILIATION_QUEUE,
              'wallet-reconciliation.cron',
              {},
              { cron: platformConfig.wallet.reconciliation.cron },
            )
            .catch((err) => logger.error({ err }, 'wallet-reconciliation schedule failed'));
        }
        const ledgerInvariantCron =
          platformConfig?.wallet?.reconciliation?.ledgerInvariantCron ??
          DEFAULT_LEDGER_INVARIANT_CRON;
        void jobQueue
          .schedule(
            LEDGER_INVARIANT_QUEUE,
            'wallet-ledger-invariant.cron',
            {},
            { cron: ledgerInvariantCron },
          )
          .catch((err) => logger.error({ err }, 'wallet-ledger-invariant schedule failed'));
      }

      if (turnoverService(c).enabled) {
        void jobQueue
          .schedule(
            TURNOVER_PRICING_QUEUE,
            'wallet-turnover-pricing.cron',
            {},
            { cron: resolveWalletTurnoverConfig(platformConfig?.wallet).pricingCron },
          )
          .catch((err) => logger.error({ err }, 'wallet-turnover-pricing schedule failed'));
      }

      const swapAdapter = c.has(SWAP_ADAPTER) ? c.get(SWAP_ADAPTER) : undefined;
      const swapVerifier = c.has(SWAP_WEBHOOK_VERIFIER) ? c.get(SWAP_WEBHOOK_VERIFIER) : undefined;
      const swap = swapAdapter
        ? new SwapService({
            drizzle: c.get(DRIZZLE),
            events: c.get(EVENT_BUS),
            adapter: swapAdapter,
            audit: c.get(AUDIT_WRITER),
            platformConfig,
            limiter: c.get(RATE_LIMITER),
            bonusFundLocks: bonusFundLocks(c),
            turnover: turnoverService(c),
          })
        : undefined;
      const swapWebhook =
        swapAdapter?.parseWebhook && swapVerifier
          ? {
              verify: swapVerifier.verify.bind(swapVerifier),
              parse: swapAdapter.parseWebhook.bind(swapAdapter),
            }
          : undefined;

      const onRampAdapter = c.has(ON_RAMP_ADAPTER) ? c.get(ON_RAMP_ADAPTER) : undefined;
      const onRampVerifier = c.has(ON_RAMP_WEBHOOK_VERIFIER)
        ? c.get(ON_RAMP_WEBHOOK_VERIFIER)
        : undefined;
      const geoCheck = c.has(GEO_CHECK_COMMANDS) ? c.get(GEO_CHECK_COMMANDS) : undefined;
      if (onRampAdapter && !geoCheck) {
        logger.warn('on-ramp vendor bound without GEO_CHECK_COMMANDS - on-ramp is off');
      }
      const onRamp =
        onRampAdapter && geoCheck
          ? new OnRampService({
              drizzle: c.get(DRIZZLE),
              wallet,
              adapter: onRampAdapter,
              audit: c.get(AUDIT_WRITER),
              playEligibility: c.get(PLAY_ELIGIBILITY),
              geoCheck,
              limiter: c.get(RATE_LIMITER),
              cache: c.has(CACHE) ? c.get(CACHE) : undefined,
            })
          : undefined;
      const onRampWebhook =
        onRampAdapter && onRampVerifier
          ? {
              verify: onRampVerifier.verify.bind(onRampVerifier),
              parse: onRampAdapter.parseWebhook.bind(onRampAdapter),
            }
          : undefined;

      return createWalletRouter({
        wallet,
        adminGuard: c.get(ADMIN_GUARD),
        audit: c.get(AUDIT_WRITER),
        withdrawalSecurity: c.get(WITHDRAWAL_SECURITY),
        paymentProviders: c.get(PAYMENT_PROVIDERS),
        reconciliation,
        jobQueue,
        reconciliationQueue: WALLET_RECONCILIATION_QUEUE,
        realtime: realtimeTransport,
        turnover: turnoverService(c),
        limiter: c.get(RATE_LIMITER),
        swap,
        swapWebhook,
        onRamp,
        onRampWebhook,
      });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

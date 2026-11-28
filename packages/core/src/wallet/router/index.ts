import { randomUUID } from 'node:crypto';
import { implement, ORPCError } from '@orpc/server';
import {
  createEventStreamGenerator,
  createLogger,
  getUserId,
  mapErrors,
  assertRateLimit,
  type AdminGuard,
  type OssContext,
} from '@openora/core/server';
import {
  BonusFundsLockedError,
  DEFAULT_PAYMENT_PROVIDER,
  RATE_LIMIT_KEYS,
  RgLimitExceededError,
  PaymentRejectedError,
  SwapLimitExceededError,
  SwapRefusedError,
  TurnoverLockedError,
  OnRampRefusedError,
  DepositRefusedError,
  OnRampVendorUnavailableError,
  makeRateLimitKey,
  type AuditWritePort,
  type JobQueueAdapter,
  type PaymentProviderRegistry,
  type PaymentWebhookEvent,
  type QueueName,
  type RateLimiterAdapter,
  type RateLimitKey,
  type RealtimeTransport,
  type SwapWebhookEvent,
  type OnRampWebhookEvent,
  type User,
  type WithdrawalSecurity,
  LedgerProjectionStaleError,
} from '@openora/core/contracts';
import { walletContract, type WalletBalanceUpdate } from '../contract/index.js';
import { CUSTODY_SWEEP_QUEUE } from '../service/custody-sweep.service.js';
import {
  WalletService,
  WalletNotFoundError,
  WithdrawalNotFoundError,
  WithdrawalNotPendingError,
  InsufficientBalanceError,
  KycRequiredError,
  WithdrawalLockedError,
  WithdrawalHeldError,
  WithdrawalPinRequiredError,
  WithdrawalPinIncorrectError,
  WithdrawalPinLockedError,
  DestinationAddressCoolingDownError,
  IdempotencyKeyReuseError,
  DepositAddressUnsupportedError,
  DestinationAddressRequiredError,
  DestinationAddressNotWhitelistedError,
  AutoWithdrawalConfigNotFoundError,
  WalletAssetNotFoundError,
  WalletAssetAlreadyExistsError,
  WalletAssetUnsupportedError,
  WalletAssetUnknownProviderError,
  WalletAssetInUseError,
  WalletAssetHasIssuedAddressesError,
  WalletAssetHasInFlightTransactionsError,
  AmbiguousNetworkError,
  UnsupportedNetworkError,
  WithdrawalDisabledError,
  BelowMinimumWithdrawalError,
  WithdrawalAmountNotAboveFeeError,
  WithdrawalPrecisionError,
  DepositDisabledError,
  BelowMinimumDepositError,
  PlayerNotFoundError,
  WithdrawalAddressAlreadyExistsError,
  WithdrawalAddressLimitReachedError,
  WalletReferenceRateUnavailableError,
  UnsupportedAmountCurrencyError,
  HeldDepositNotFoundError,
  DepositStillHeldError,
  DepositAlreadyOnLedgerError,
} from '../service/wallet.service.js';
import {
  SwapService,
  SwapPairUnsupportedError,
  SwapUnavailableError,
} from '../service/swap.service.js';
import {
  type OnRampService,
  OnRampGeoBlockedError,
  OnRampOrderNotFoundError,
  OnRampRestrictedError,
  OnRampUnavailableError,
} from '../service/on-ramp.service.js';
import {
  ReconciliationService,
  ReconciliationFindingNotFoundError,
  ReconciliationCreditTransactionNotFoundError,
  ReconciliationCreditMismatchError,
  ReconciliationOutcomeNotAllowedError,
  ReconciliationRefundAmountError,
  ReconciliationAttributionError,
  DepositAlreadyRefundedError,
  LEDGER_INVARIANT_QUEUE,
} from '../service/reconciliation.service.js';
import type { TurnoverService } from '../service/turnover.service.js';

const WALLET_WEBHOOK_RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };

async function dispatchWebhook(
  wallet: WalletService,
  paymentProviders: PaymentProviderRegistry,
  providerName: string,
  rawBody: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ ok: true }> {
  const provider = paymentProviders.get(providerName);
  if (
    rawBody === undefined ||
    !provider ||
    !(await provider.webhookVerifier.verify(rawBody, headers))
  ) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Invalid payment webhook signature' });
  }
  const event: PaymentWebhookEvent | null | undefined = provider.adapter.parseWebhook?.(
    rawBody,
    headers,
  );
  if (event) {
    if (event.kind === 'deposit') {
      await wallet.creditDepositByAddress(event, providerName);
    } else if (event.kind === 'deposit_status') {
      await wallet.recordDepositStatus(event);
    } else {
      await wallet.reconcileWithdrawalStatus(event, providerName);
    }
  }
  return { ok: true as const };
}

export function walletBalanceChannel(userId: User['id']): string {
  return `wallet:balance:${userId}`;
}

function createWalletBalanceStream(
  realtime: RealtimeTransport,
  userId: User['id'],
  signal: AbortSignal | undefined,
): AsyncGenerator<WalletBalanceUpdate> {
  return createEventStreamGenerator(
    (push) => realtime.subscribe<WalletBalanceUpdate>(walletBalanceChannel(userId), push),
    { signal },
  );
}

const logger = createLogger('wallet-router');

export type WalletRouterDeps = {
  wallet: WalletService;
  adminGuard: AdminGuard;
  audit: AuditWritePort;
  withdrawalSecurity: WithdrawalSecurity;
  paymentProviders: PaymentProviderRegistry;
  reconciliation: ReconciliationService;
  jobQueue: JobQueueAdapter;
  reconciliationQueue: QueueName;
  realtime: RealtimeTransport;
  turnover: TurnoverService;
  limiter?: RateLimiterAdapter<RateLimitKey>;
  swap?: SwapService;
  swapWebhook?: SwapWebhookPort;
  onRamp?: OnRampService;
  onRampWebhook?: OnRampWebhookPort;
};

type OnRampWebhookPort = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
  parse(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): OnRampWebhookEvent | null;
};

type SwapWebhookPort = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
  parse(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): SwapWebhookEvent | null;
};

export function createWalletRouter({
  wallet,
  adminGuard,
  audit,
  withdrawalSecurity,
  paymentProviders,
  reconciliation,
  jobQueue,
  reconciliationQueue,
  realtime,
  turnover,
  limiter,
  swap,
  swapWebhook,
  onRamp,
  onRampWebhook,
}: WalletRouterDeps) {
  const os = implement(walletContract).$context<OssContext>();

  const throttleWebhook = (context: OssContext) =>
    assertRateLimit(
      limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.WALLET_WEBHOOK, context.clientMeta.ip ?? 'unknown'),
      WALLET_WEBHOOK_RATE_LIMIT,
    );

  const requireSwap = (): SwapService => {
    if (!swap) {
      throw new SwapUnavailableError();
    }
    return swap;
  };

  const requireOnRamp = (): OnRampService => {
    if (!onRamp) {
      throw new OnRampUnavailableError();
    }
    return onRamp;
  };

  const onRampRefusals = {
    FORBIDDEN: [OnRampRestrictedError, OnRampGeoBlockedError, DepositRefusedError],
    CONFLICT: [
      OnRampUnavailableError,
      OnRampVendorUnavailableError,
      RgLimitExceededError,
      DepositAddressUnsupportedError,
      IdempotencyKeyReuseError,
    ],
    SERVICE_UNAVAILABLE: WalletReferenceRateUnavailableError,
    BAD_REQUEST: [OnRampRefusedError, UnsupportedNetworkError, DepositDisabledError],
  };

  return os.router({
    getBalance: os.getBalance.handler(({ context }) => wallet.getBalance(getUserId(context))),

    getBalances: os.getBalances.handler(({ context }) => wallet.getBalances(getUserId(context))),

    streamBalance: os.streamBalance.handler(({ signal, context }) => {
      return createWalletBalanceStream(realtime, getUserId(context), signal);
    }),

    setActiveCurrency: os.setActiveCurrency.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: WalletNotFoundError }, () =>
        wallet.setActiveCurrency(getUserId(context), input.currency),
      ),
    ),

    deposit: os.deposit.handler(({ input, context }) =>
      mapErrors(
        {
          BAD_REQUEST: [UnsupportedNetworkError, BelowMinimumDepositError, DepositDisabledError],
          CONFLICT: [IdempotencyKeyReuseError, RgLimitExceededError],
          FORBIDDEN: DepositRefusedError,
          SERVICE_UNAVAILABLE: [WalletReferenceRateUnavailableError, LedgerProjectionStaleError],
        },
        () =>
          wallet.deposit({
            userId: getUserId(context),
            amount: input.amount,
            currency: input.currency,
            provider: input.provider,
            idempotencyKey: input.idempotencyKey,
          }),
      ),
    ),

    withdraw: os.withdraw.handler(({ input, context }) => {
      return mapErrors(
        {
          NOT_FOUND: WalletNotFoundError,
          BAD_REQUEST: [
            InsufficientBalanceError,
            AmbiguousNetworkError,
            UnsupportedNetworkError,
            BelowMinimumWithdrawalError,
            WithdrawalAmountNotAboveFeeError,
            WithdrawalPrecisionError,
          ],
          CONFLICT: [
            WithdrawalLockedError,
            WithdrawalHeldError,
            KycRequiredError,
            IdempotencyKeyReuseError,
            DestinationAddressRequiredError,
            DestinationAddressNotWhitelistedError,
            DestinationAddressCoolingDownError,
            WithdrawalPinRequiredError,
            WithdrawalPinIncorrectError,
            WithdrawalPinLockedError,
            WithdrawalDisabledError,
            BonusFundsLockedError,
            TurnoverLockedError,
          ],
          SERVICE_UNAVAILABLE: WalletReferenceRateUnavailableError,
        },
        () =>
          wallet.withdraw({
            userId: getUserId(context),
            amount: input.amount,
            currency: input.currency,
            network: input.network,
            idempotencyKey: input.idempotencyKey,
            destinationAddress: input.destinationAddress,
            destinationTag: input.destinationTag,
            withdrawalPin: input.withdrawalPin,
            ...context.clientMeta,
          }),
      );
    }),

    manualAdjustment: os.manualAdjustment.handler(async ({ input, context }) => {
      const {
        userId: adminId,
        ip,
        userAgent,
      } = await adminGuard.assertSuperAdmin(context, {
        resource: 'wallet',
        action: 'manualAdjustment',
      });
      return mapErrors(
        {
          NOT_FOUND: PlayerNotFoundError,
          BAD_REQUEST: InsufficientBalanceError,
          CONFLICT: IdempotencyKeyReuseError,
          SERVICE_UNAVAILABLE: WalletReferenceRateUnavailableError,
        },
        () => wallet.manualAdjust({ ...input, adminId, ip, userAgent }),
      );
    }),

    listTransactions: os.listTransactions.handler(({ context, input }) =>
      mapErrors({ BAD_REQUEST: UnsupportedAmountCurrencyError }, () =>
        wallet.getTransactions({ ...input, userId: getUserId(context), includeGrants: true }),
      ),
    ),

    listPlayerTransactions: os.listPlayerTransactions.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'transaction', 'view');
      return mapErrors({ BAD_REQUEST: UnsupportedAmountCurrencyError }, () =>
        wallet.getTransactions({ ...input, includeInternal: true }),
      );
    }),

    withdrawals: {
      list: os.withdrawals.list.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'withdrawal', 'view');
        return wallet.listWithdrawals(input);
      }),

      summary: os.withdrawals.summary.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'withdrawal', 'view');
        return wallet.summarizeWithdrawals(input);
      }),

      approve: os.withdrawals.approve.handler(async ({ input, context }) => {
        const {
          userId: adminId,
          ip,
          userAgent,
        } = await adminGuard.assert(context, 'withdrawal', 'approve');
        return mapErrors(
          {
            NOT_FOUND: WithdrawalNotFoundError,
            CONFLICT: [
              WithdrawalNotPendingError,
              WithdrawalLockedError,
              WithdrawalHeldError,
              WithdrawalPinLockedError,
              KycRequiredError,
              PaymentRejectedError,
            ],
          },
          () => wallet.approveWithdrawal(adminId, input.withdrawalId, { ip, userAgent }),
        );
      }),

      reject: os.withdrawals.reject.handler(async ({ input, context }) => {
        const {
          userId: adminId,
          ip,
          userAgent,
        } = await adminGuard.assert(context, 'withdrawal', 'reject');
        return mapErrors(
          { NOT_FOUND: WithdrawalNotFoundError, CONFLICT: WithdrawalNotPendingError },
          () =>
            wallet.rejectWithdrawal(adminId, input.withdrawalId, input.reason, { ip, userAgent }),
        );
      }),
    },

    autoWithdrawalRules: {
      set: os.autoWithdrawalRules.set.handler(async ({ input, context }) => {
        const {
          userId: adminId,
          ip,
          userAgent,
        } = await adminGuard.assert(context, 'withdrawal', 'auto-rule');
        const before = await wallet.getAutoWithdrawalRule(input.userId);
        const rule = await wallet.setAutoWithdrawalRule({
          userId: input.userId,
          threshold: input.threshold,
          reason: input.reason,
          createdBy: adminId,
        });
        await audit.record({
          actorId: adminId,
          actorType: 'admin',
          action: 'wallet.auto_withdrawal_rule.set',
          resourceType: 'auto_withdrawal_rule',
          resourceId: input.userId,
          before: before ? { threshold: before.threshold, reason: before.reason } : null,
          after: { threshold: rule.threshold, reason: rule.reason },
          ip,
          userAgent,
        });
        return rule;
      }),

      get: os.autoWithdrawalRules.get.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'withdrawal', 'auto-rule');
        return wallet.getAutoWithdrawalRule(input.userId);
      }),

      delete: os.autoWithdrawalRules.delete.handler(async ({ input, context }) => {
        const {
          userId: adminId,
          ip,
          userAgent,
        } = await adminGuard.assert(context, 'withdrawal', 'auto-rule');
        const before = await wallet.getAutoWithdrawalRule(input.userId);
        const deleted = await wallet.deleteAutoWithdrawalRule(input.userId);
        if (deleted) {
          await audit.record({
            actorId: adminId,
            actorType: 'admin',
            action: 'wallet.auto_withdrawal_rule.deleted',
            resourceType: 'auto_withdrawal_rule',
            resourceId: input.userId,
            before: before ? { threshold: before.threshold, reason: before.reason } : null,
            after: null,
            ip,
            userAgent,
          });
        }
        return deleted;
      }),
    },

    autoWithdrawalConfig: {
      set: os.autoWithdrawalConfig.set.handler(async ({ input, context }) => {
        const {
          userId: adminId,
          ip,
          userAgent,
        } = await adminGuard.assert(context, 'auto-withdrawal-config', 'update');
        return wallet.setAutoWithdrawalConfig(adminId, input, { ip, userAgent });
      }),

      get: os.autoWithdrawalConfig.get.handler(async ({ context }) => {
        await adminGuard.assert(context, 'auto-withdrawal-config', 'view');
        return mapErrors({ NOT_FOUND: AutoWithdrawalConfigNotFoundError }, () =>
          wallet.getAutoWithdrawalConfig(),
        );
      }),
    },

    turnover: {
      get: os.turnover.get.handler(({ context }) => turnover.summary(getUserId(context))),

      entries: os.turnover.entries.handler(({ input, context }) =>
        turnover.entries(getUserId(context), input),
      ),
    },

    admin: {
      turnover: {
        get: os.admin.turnover.get.handler(async ({ input, context }) => {
          await adminGuard.assert(context, 'turnover', 'view');
          return turnover.adminSummary(input.userId);
        }),

        entries: os.admin.turnover.entries.handler(async ({ input, context }) => {
          await adminGuard.assert(context, 'turnover', 'view');
          const { userId, ...page } = input;
          return turnover.adminEntries(userId, page);
        }),

        clear: os.admin.turnover.clear.handler(async ({ input, context }) => {
          const {
            userId: adminId,
            ip,
            userAgent,
          } = await adminGuard.assert(context, 'turnover', 'clear');
          return turnover.clear(adminId, input, { ip, userAgent });
        }),
      },

      turnoverConfig: {
        get: os.admin.turnoverConfig.get.handler(async ({ context }) => {
          await adminGuard.assert(context, 'turnover-config', 'view');
          return turnover.getConfig();
        }),

        update: os.admin.turnoverConfig.update.handler(async ({ input, context }) => {
          const {
            userId: adminId,
            ip,
            userAgent,
          } = await adminGuard.assert(context, 'turnover-config', 'update');
          return turnover.updateConfig(adminId, input, { ip, userAgent });
        }),
      },
    },

    listAssets: os.listAssets.handler(() => wallet.listEnabledWalletAssets()),

    assets: {
      list: os.assets.list.handler(async ({ context }) => {
        await adminGuard.assert(context, 'wallet-asset', 'view');
        return wallet.listWalletAssets();
      }),

      create: os.assets.create.handler(async ({ input, context }) => {
        const {
          userId: adminId,
          ip,
          userAgent,
        } = await adminGuard.assert(context, 'wallet-asset', 'create');
        return mapErrors(
          {
            CONFLICT: [
              WalletAssetAlreadyExistsError,
              WalletAssetUnsupportedError,
              WalletAssetUnknownProviderError,
            ],
          },
          () => wallet.createWalletAsset(adminId, input, { ip, userAgent }),
        );
      }),

      update: os.assets.update.handler(async ({ input, context }) => {
        const {
          userId: adminId,
          ip,
          userAgent,
        } = await adminGuard.assert(context, 'wallet-asset', 'update');
        return mapErrors(
          {
            NOT_FOUND: WalletAssetNotFoundError,
            CONFLICT: WalletAssetUnsupportedError,
          },
          () => wallet.updateWalletAsset(adminId, input, { ip, userAgent }),
        );
      }),

      delete: os.assets.delete.handler(async ({ input, context }) => {
        const {
          userId: adminId,
          ip,
          userAgent,
        } = await adminGuard.assert(context, 'wallet-asset', 'delete');
        return mapErrors(
          {
            CONFLICT: [
              WalletAssetInUseError,
              WalletAssetHasIssuedAddressesError,
              WalletAssetHasInFlightTransactionsError,
            ],
          },
          () => wallet.deleteWalletAsset(adminId, input.currency, input.network, { ip, userAgent }),
        );
      }),
    },

    withdrawalAddresses: {
      list: os.withdrawalAddresses.list.handler(({ input, context }) =>
        wallet.listWithdrawalAddresses(getUserId(context), input.currency),
      ),

      create: os.withdrawalAddresses.create.handler(async ({ input, context }) => {
        const userId = getUserId(context);
        const { currentPassword, totpCode, ...address } = input;
        await withdrawalSecurity.assertReauthentication({
          userId,
          headers: context.request.headers,
          currentPassword,
          totpCode,
          meta: context.clientMeta,
        });
        return mapErrors(
          {
            CONFLICT: [WithdrawalAddressAlreadyExistsError, WithdrawalAddressLimitReachedError],
          },
          () => wallet.createWithdrawalAddress(userId, address, context.clientMeta),
        );
      }),

      delete: os.withdrawalAddresses.delete.handler(({ input, context }) =>
        wallet.deleteWithdrawalAddress(getUserId(context), input.id, context.clientMeta),
      ),
    },

    deposits: {
      getAddress: os.deposits.getAddress.handler(({ input, context }) =>
        mapErrors(
          {
            BAD_REQUEST: [UnsupportedNetworkError, DepositDisabledError],
            CONFLICT: DepositAddressUnsupportedError,
            FORBIDDEN: DepositRefusedError,
          },
          () => wallet.getOrCreateDepositAddress(getUserId(context), input.currency, input.network),
        ),
      ),
    },

    swap: {
      quote: os.swap.quote.handler(({ input, context }) =>
        mapErrors(
          {
            CONFLICT: [SwapUnavailableError, SwapPairUnsupportedError, SwapRefusedError],
            BAD_REQUEST: SwapLimitExceededError,
          },
          () => requireSwap().quote({ userId: getUserId(context), ...input }),
        ),
      ),

      execute: os.swap.execute.handler(({ input, context }) =>
        mapErrors(
          {
            NOT_FOUND: WalletNotFoundError,
            CONFLICT: [
              SwapUnavailableError,
              SwapPairUnsupportedError,
              IdempotencyKeyReuseError,
              SwapRefusedError,
              BonusFundsLockedError,
            ],
            BAD_REQUEST: [InsufficientBalanceError, SwapLimitExceededError],
          },
          () => requireSwap().swap({ userId: getUserId(context), ...input }),
        ),
      ),

      webhook: os.swap.webhook.handler(async ({ context }) => {
        await throttleWebhook(context);
        const rawBody = context.rawBody;
        if (
          !swap ||
          !swapWebhook ||
          rawBody === undefined ||
          !(await swapWebhook.verify(rawBody, context.request.headers))
        ) {
          throw new ORPCError('UNAUTHORIZED', { message: 'Invalid swap webhook signature' });
        }
        const event = swapWebhook.parse(rawBody, context.request.headers);
        if (event) {
          await swap.reconcileSwapStatus(event);
        }
        return { ok: true as const };
      }),
    },

    onRamp: {
      options: os.onRamp.options.handler(({ context }) =>
        mapErrors(onRampRefusals, () =>
          requireOnRamp().options(getUserId(context), context.clientMeta),
        ),
      ),

      quote: os.onRamp.quote.handler(({ input, context }) =>
        mapErrors(onRampRefusals, () =>
          requireOnRamp().quote({ userId: getUserId(context), meta: context.clientMeta, ...input }),
        ),
      ),

      checkout: os.onRamp.checkout.handler(({ input, context }) =>
        mapErrors(onRampRefusals, () =>
          requireOnRamp().checkout({
            userId: getUserId(context),
            meta: context.clientMeta,
            fiatCurrency: input.fiatCurrency,
            fiatAmount: input.fiatAmount,
            currency: input.currency,
            network: input.network,
            idempotencyKey: input.idempotencyKey,
          }),
        ),
      ),

      order: os.onRamp.order.handler(({ input, context }) =>
        mapErrors({ NOT_FOUND: OnRampOrderNotFoundError, CONFLICT: OnRampUnavailableError }, () =>
          requireOnRamp().getOrder(getUserId(context), input.purchaseId),
        ),
      ),

      webhook: os.onRamp.webhook.handler(async ({ context }) => {
        await throttleWebhook(context);
        const rawBody = context.rawBody;
        const verified =
          onRampWebhook !== undefined &&
          rawBody !== undefined &&
          (await Promise.resolve()
            .then(() => onRampWebhook.verify(rawBody, context.request.headers))
            .catch((err: unknown) => {
              logger.warn({ err }, 'on-ramp webhook verifier threw - rejected');
              return false;
            }));
        if (!onRamp || !onRampWebhook || !verified) {
          throw new ORPCError('UNAUTHORIZED', { message: 'Invalid on-ramp webhook signature' });
        }
        const event = onRampWebhook.parse(rawBody, context.request.headers);
        if (event) {
          await onRamp.recordWebhook(event);
        }
        return { ok: true as const };
      }),
    },

    webhook: os.webhook.handler(async ({ context }) => {
      await throttleWebhook(context);
      return dispatchWebhook(
        wallet,
        paymentProviders,
        DEFAULT_PAYMENT_PROVIDER,
        context.rawBody,
        context.request.headers,
      );
    }),

    webhookForProvider: os.webhookForProvider.handler(async ({ input, context }) => {
      await throttleWebhook(context);
      return dispatchWebhook(
        wallet,
        paymentProviders,
        input.provider,
        context.rawBody,
        context.request.headers,
      );
    }),

    custody: {
      sweep: {
        run: os.custody.sweep.run.handler(async ({ context }) => {
          await adminGuard.assert(context, 'wallet-custody', 'run');
          const runId = randomUUID();
          await jobQueue.enqueue(CUSTODY_SWEEP_QUEUE, { runId });
          return { runId };
        }),
      },
    },

    reconciliation: {
      list: os.reconciliation.list.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'wallet-reconciliation', 'view');
        return reconciliation.listFindings(input);
      }),

      resolve: os.reconciliation.resolve.handler(async ({ input, context }) => {
        const {
          userId: adminId,
          ip,
          userAgent,
        } = await adminGuard.assert(context, 'wallet-reconciliation', 'resolve');
        const { outcome } = input.resolution;
        if (
          outcome === 'credited' ||
          outcome === 'released' ||
          outcome === 'rebaselined' ||
          (outcome === 'dismissed' && (await reconciliation.isLedgerFinding(input.id)))
        ) {
          await adminGuard.assertSuperAdmin(context);
        }
        return mapErrors(
          {
            NOT_FOUND: [
              ReconciliationFindingNotFoundError,
              ReconciliationCreditTransactionNotFoundError,
              PlayerNotFoundError,
            ],
            CONFLICT: [
              ReconciliationCreditMismatchError,
              ReconciliationOutcomeNotAllowedError,
              ReconciliationRefundAmountError,
              ReconciliationAttributionError,
              HeldDepositNotFoundError,
              DepositStillHeldError,
              DepositAlreadyOnLedgerError,
              DepositAlreadyRefundedError,
            ],
          },
          () =>
            reconciliation.resolveFinding(adminId, input.id, input.resolution, { ip, userAgent }),
        );
      }),

      run: os.reconciliation.run.handler(async ({ context }) => {
        await adminGuard.assert(context, 'wallet-reconciliation', 'run');
        const runId = randomUUID();
        await jobQueue.enqueue(reconciliationQueue, { runId });
        return { runId };
      }),

      ledgerInvariant: os.reconciliation.ledgerInvariant.handler(async ({ input, context }) => {
        const { userId: adminId } = await adminGuard.assert(
          context,
          'wallet-reconciliation',
          'run',
        );
        const runId = randomUUID();
        if (input.backfillBaselines) {
          const { ip, userAgent } = await adminGuard.assertSuperAdmin(context, {
            resource: 'wallet-reconciliation',
            action: 'ledgerInvariant',
          });
          await audit.record({
            actorId: adminId,
            actorType: 'admin',
            action: 'wallet.ledger_invariant_run.requested',
            resourceType: 'wallet_job_run',
            resourceId: runId,
            after: { runId, backfillBaselines: true },
            ip,
            userAgent,
          });
        }
        await jobQueue.enqueue(LEDGER_INVARIANT_QUEUE, {
          runId,
          backfillBaselines: input.backfillBaselines,
        });
        return { runId };
      }),
    },
  });
}

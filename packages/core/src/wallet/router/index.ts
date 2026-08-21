import { randomUUID } from 'node:crypto';
import { implement, ORPCError } from '@orpc/server';
import {
  getUserId,
  mapErrors,
  assertRateLimit,
  type AdminGuard,
  type OssContext,
} from '@openora/core/server';
import {
  DEFAULT_PAYMENT_PROVIDER,
  RATE_LIMIT_KEYS,
  makeRateLimitKey,
  type AuditWritePort,
  type JobQueueAdapter,
  type PaymentProviderRegistry,
  type PaymentWebhookEvent,
  type QueueName,
  type RateLimiterAdapter,
  type RateLimitKey,
} from '@openora/core/contracts';
import { walletContract } from '../contract/index.js';
import { CUSTODY_SWEEP_QUEUE } from '../service/custody-sweep.service.js';
import {
  WalletService,
  WalletNotFoundError,
  WithdrawalNotFoundError,
  WithdrawalNotPendingError,
  InsufficientBalanceError,
  KycRequiredError,
  IdempotencyKeyReuseError,
  DepositAddressUnsupportedError,
  DestinationAddressRequiredError,
  AutoWithdrawalConfigNotFoundError,
  WalletAssetNotFoundError,
  WalletAssetAlreadyExistsError,
  WalletAssetUnsupportedError,
  WalletAssetUnknownProviderError,
  WalletAssetInUseError,
  WalletAssetHasInFlightTransactionsError,
  AmbiguousNetworkError,
  UnsupportedNetworkError,
  WithdrawalDisabledError,
  BelowMinimumWithdrawalError,
  PlayerNotFoundError,
} from '../service/wallet.service.js';
import {
  ReconciliationService,
  ReconciliationFindingNotFoundError,
  ReconciliationCreditTransactionNotFoundError,
  ReconciliationCreditMismatchError,
} from '../service/reconciliation.service.js';

// Unauthenticated route: it costs a signature verification (and, for a custody vendor,
// a DB lookup) per request with nothing else gating it. Keyed on client IP, not a
// vendor/account identity, since an attacker chooses neither. A request with no IP
// signal (proxy misconfiguration) still shares one bucket rather than skipping the
// limiter outright - "no signal" must never mean "no limit".
const WALLET_WEBHOOK_RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };

async function dispatchWebhook(
  wallet: WalletService,
  paymentProviders: PaymentProviderRegistry,
  providerName: string,
  rawBody: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ ok: true }> {
  const provider = paymentProviders.get(providerName);
  // A missing provider fails the exact same shape as a bad signature - the path segment
  // must never let an attacker enumerate which vendors are bound.
  if (
    rawBody === undefined ||
    !provider ||
    !(await provider.webhookVerifier.verify(rawBody, headers))
  ) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Invalid payment webhook signature' });
  }
  // Always the SAME provider's adapter that verified the signature - never verify with
  // one vendor's key and parse with another's format (signature confusion).
  const event: PaymentWebhookEvent | null | undefined = provider.adapter.parseWebhook?.(
    rawBody,
    headers,
  );
  if (event) {
    if (event.kind === 'deposit') {
      await wallet.creditDepositByAddress(event, providerName);
    } else {
      await wallet.reconcileWithdrawalStatus(event);
    }
  }
  return { ok: true as const };
}

/**
 * Named rather than positional. Half of these are structurally similar ports, so a
 * positional slip type-checks; and the sweep and reconciliation branches each add their
 * own dependencies here, which as positional parameters git merges into a signature that
 * declares one twice without ever reporting a conflict.
 */
export type WalletRouterDeps = {
  wallet: WalletService;
  adminGuard: AdminGuard;
  audit: AuditWritePort;
  paymentProviders: PaymentProviderRegistry;
  reconciliation: ReconciliationService;
  jobQueue: JobQueueAdapter;
  reconciliationQueue: QueueName;
  limiter?: RateLimiterAdapter<RateLimitKey>;
};

export function createWalletRouter({
  wallet,
  adminGuard,
  audit,
  paymentProviders,
  reconciliation,
  jobQueue,
  reconciliationQueue,
  limiter,
}: WalletRouterDeps) {
  const os = implement(walletContract).$context<OssContext>();

  const throttleWebhook = (context: OssContext) =>
    assertRateLimit(
      limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.WALLET_WEBHOOK, context.clientMeta.ip ?? 'unknown'),
      WALLET_WEBHOOK_RATE_LIMIT,
    );

  return os.router({
    getBalance: os.getBalance.handler(({ context }) => wallet.getBalance(getUserId(context))),

    getBalances: os.getBalances.handler(({ context }) => wallet.getBalances(getUserId(context))),

    setActiveCurrency: os.setActiveCurrency.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: WalletNotFoundError }, () =>
        wallet.setActiveCurrency(getUserId(context), input.currency),
      ),
    ),

    deposit: os.deposit.handler(({ input, context }) =>
      mapErrors({ CONFLICT: IdempotencyKeyReuseError }, () =>
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
          ],
          CONFLICT: [
            KycRequiredError,
            IdempotencyKeyReuseError,
            DestinationAddressRequiredError,
            WithdrawalDisabledError,
          ],
        },
        () =>
          wallet.withdraw({
            userId: getUserId(context),
            amount: input.amount,
            currency: input.currency,
            network: input.network,
            idempotencyKey: input.idempotencyKey,
            destinationAddress: input.destinationAddress,
            ...context.clientMeta,
          }),
      );
    }),

    manualAdjustment: os.manualAdjustment.handler(async ({ input, context }) => {
      const {
        userId: adminId,
        ip,
        userAgent,
      } = await adminGuard.assert(context, 'player', 'adjust-balance');
      return mapErrors(
        {
          NOT_FOUND: PlayerNotFoundError,
          BAD_REQUEST: InsufficientBalanceError,
          CONFLICT: IdempotencyKeyReuseError,
        },
        () => wallet.manualAdjust({ ...input, adminId, ip, userAgent }),
      );
    }),

    listTransactions: os.listTransactions.handler(({ context, input }) =>
      wallet.getTransactions({
        userId: getUserId(context),
        page: input.page,
        limit: input.limit,
        sortBy: input.sortBy,
        sortOrder: input.sortOrder,
      }),
    ),

    listPlayerTransactions: os.listPlayerTransactions.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'transaction', 'view');
      return wallet.getTransactions({
        userId: input.userId,
        page: input.page,
        limit: input.limit,
        sortBy: input.sortBy,
        sortOrder: input.sortOrder,
        includeInternal: true,
      });
    }),

    withdrawals: {
      list: os.withdrawals.list.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'withdrawal', 'view');
        return wallet.listWithdrawals(input);
      }),

      approve: os.withdrawals.approve.handler(async ({ input, context }) => {
        const {
          userId: adminId,
          ip,
          userAgent,
        } = await adminGuard.assert(context, 'withdrawal', 'approve');
        return mapErrors(
          { NOT_FOUND: WithdrawalNotFoundError, CONFLICT: WithdrawalNotPendingError },
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
        // The before-read, upsert, and audit write all run inside one transaction in
        // the service - an audit failure rolls back the threshold change too.
        return wallet.setAutoWithdrawalConfig(adminId, input, { ip, userAgent });
      }),

      get: os.autoWithdrawalConfig.get.handler(async ({ context }) => {
        await adminGuard.assert(context, 'auto-withdrawal-config', 'view');
        return mapErrors({ NOT_FOUND: AutoWithdrawalConfigNotFoundError }, () =>
          wallet.getAutoWithdrawalConfig(),
        );
      }),
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
          { CONFLICT: [WalletAssetInUseError, WalletAssetHasInFlightTransactionsError] },
          () => wallet.deleteWalletAsset(adminId, input.currency, input.network, { ip, userAgent }),
        );
      }),
    },

    deposits: {
      getAddress: os.deposits.getAddress.handler(({ input, context }) =>
        mapErrors({ CONFLICT: DepositAddressUnsupportedError }, () =>
          wallet.getOrCreateDepositAddress(getUserId(context), input.currency, input.network),
        ),
      ),
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
          // The run claim (a unique-index insert in wallet_job_run) is the sole
          // concurrency authority, not this request - enqueue and return immediately so
          // an HTTP timeout can never orphan a cycle. runId is minted here so the caller
          // gets it back synchronously, before the job actually runs.
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
        return mapErrors(
          {
            NOT_FOUND: [
              ReconciliationFindingNotFoundError,
              ReconciliationCreditTransactionNotFoundError,
            ],
            CONFLICT: ReconciliationCreditMismatchError,
          },
          () =>
            reconciliation.resolveFinding(adminId, input.id, input.resolution, { ip, userAgent }),
        );
      }),

      // Enqueues the job and returns the runId immediately - never runs inline. The
      // eventual worker's own claim (wallet_job_run's partial unique index) stays the
      // single concurrency authority; this route does not know or care whether its
      // claim will win.
      run: os.reconciliation.run.handler(async ({ context }) => {
        await adminGuard.assert(context, 'wallet-reconciliation', 'run');
        const runId = randomUUID();
        await jobQueue.enqueue(reconciliationQueue, { runId });
        return { runId };
      }),
    },
  });
}

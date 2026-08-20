import { implement, ORPCError } from '@orpc/server';
import { getUserId, mapErrors, type AdminGuard, type OssContext } from '@openora/core/server';
import type {
  AuditWritePort,
  PaymentAdapter,
  PaymentWebhookVerifier,
} from '@openora/core/contracts';
import { walletContract } from '../contract/index.js';
import {
  WalletService,
  WalletNotFoundError,
  WithdrawalNotFoundError,
  WithdrawalNotPendingError,
  InsufficientBalanceError,
  CurrencyMismatchError,
  KycRequiredError,
  IdempotencyKeyReuseError,
  DepositAddressUnsupportedError,
  DestinationAddressRequiredError,
  AutoWithdrawalConfigNotFoundError,
  WalletAssetNotFoundError,
  WalletAssetAlreadyExistsError,
  WalletAssetUnsupportedError,
  WalletAssetInUseError,
  AmbiguousNetworkError,
  UnsupportedNetworkError,
  WithdrawalDisabledError,
  BelowMinimumWithdrawalError,
} from '../service/wallet.service.js';

export function createWalletRouter(
  wallet: WalletService,
  adminGuard: AdminGuard,
  audit: AuditWritePort,
  paymentAdapter: PaymentAdapter,
  webhookVerifier: PaymentWebhookVerifier,
) {
  const os = implement(walletContract).$context<OssContext>();

  return os.router({
    getBalance: os.getBalance.handler(({ context }) => wallet.getBalance(getUserId(context))),

    getBalances: os.getBalances.handler(({ context }) => wallet.getBalances(getUserId(context))),

    setActiveCurrency: os.setActiveCurrency.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: WalletNotFoundError }, () =>
        wallet.setActiveCurrency(getUserId(context), input.currency),
      ),
    ),

    deposit: os.deposit.handler(({ input, context }) =>
      mapErrors({ BAD_REQUEST: CurrencyMismatchError, CONFLICT: IdempotencyKeyReuseError }, () =>
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
            CurrencyMismatchError,
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
          { CONFLICT: [WalletAssetAlreadyExistsError, WalletAssetUnsupportedError] },
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
        return mapErrors({ CONFLICT: WalletAssetInUseError }, () =>
          wallet.deleteWalletAsset(adminId, input.currency, input.network, { ip, userAgent }),
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
      const rawBody = context.rawBody;
      if (
        rawBody === undefined ||
        !(await webhookVerifier.verify(rawBody, context.request.headers))
      ) {
        throw new ORPCError('UNAUTHORIZED', { message: 'Invalid payment webhook signature' });
      }
      const event = paymentAdapter.parseWebhook?.(rawBody, context.request.headers);
      if (event) {
        if (event.kind === 'deposit') {
          await wallet.creditDepositByAddress(event);
        } else {
          await wallet.reconcileWithdrawalStatus(event);
        }
      }
      return { ok: true as const };
    }),
  });
}

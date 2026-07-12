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

    withdraw: os.withdraw.handler(({ input, context }) =>
      mapErrors(
        {
          NOT_FOUND: WalletNotFoundError,
          BAD_REQUEST: [InsufficientBalanceError, CurrencyMismatchError],
          CONFLICT: [KycRequiredError, IdempotencyKeyReuseError, DestinationAddressRequiredError],
        },
        () =>
          wallet.withdraw({
            userId: getUserId(context),
            amount: input.amount,
            currency: input.currency,
            idempotencyKey: input.idempotencyKey,
            destinationAddress: input.destinationAddress,
          }),
      ),
    ),

    listTransactions: os.listTransactions.handler(({ context, input }) =>
      wallet.getTransactions(getUserId(context), input.page, input.limit),
    ),

    listPlayerTransactions: os.listPlayerTransactions.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'transaction', 'view');
      return wallet.getTransactions(input.userId, input.page, input.limit);
    }),

    withdrawals: {
      list: os.withdrawals.list.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'withdrawal', 'view');
        return wallet.listWithdrawals(input);
      }),

      approve: os.withdrawals.approve.handler(async ({ input, context }) => {
        const { userId: adminId } = await adminGuard.assert(context, 'withdrawal', 'approve');
        return mapErrors(
          { NOT_FOUND: WithdrawalNotFoundError, CONFLICT: WithdrawalNotPendingError },
          () => wallet.approveWithdrawal(adminId, input.withdrawalId),
        );
      }),

      reject: os.withdrawals.reject.handler(async ({ input, context }) => {
        const { userId: adminId } = await adminGuard.assert(context, 'withdrawal', 'reject');
        return mapErrors(
          { NOT_FOUND: WithdrawalNotFoundError, CONFLICT: WithdrawalNotPendingError },
          () => wallet.rejectWithdrawal(adminId, input.withdrawalId, input.reason),
        );
      }),
    },

    autoWithdrawalRules: {
      set: os.autoWithdrawalRules.set.handler(async ({ input, context }) => {
        const { userId: adminId } = await adminGuard.assert(context, 'withdrawal', 'auto-rule');
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
        });
        return rule;
      }),

      get: os.autoWithdrawalRules.get.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'withdrawal', 'auto-rule');
        return wallet.getAutoWithdrawalRule(input.userId);
      }),

      delete: os.autoWithdrawalRules.delete.handler(async ({ input, context }) => {
        const { userId: adminId } = await adminGuard.assert(context, 'withdrawal', 'auto-rule');
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
          });
        }
        return deleted;
      }),
    },

    deposits: {
      getAddress: os.deposits.getAddress.handler(({ input, context }) =>
        mapErrors({ CONFLICT: DepositAddressUnsupportedError }, () =>
          wallet.getOrCreateDepositAddress(getUserId(context), input.currency),
        ),
      ),
    },

    // M2M payment-vendor webhook - no admin session. Verify the verbatim bytes against
    // the signature header or reject (fail closed); never fall back to an empty body.
    webhook: os.webhook.handler(async ({ context }) => {
      const rawBody = context.rawBody;
      if (rawBody === undefined || !webhookVerifier.verify(rawBody, context.request.headers)) {
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

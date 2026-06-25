import { implement } from '@orpc/server';
import { getUserId, mapErrors, type AdminGuard, type OssContext } from '@blurifycom/core/server';
import { walletContract } from '../contract/index.js';
import {
  WalletService,
  WalletNotFoundError,
  WithdrawalNotFoundError,
  WithdrawalNotPendingError,
  InsufficientBalanceError,
  CurrencyMismatchError,
} from '../service/wallet.service.js';

export function createWalletRouter(wallet: WalletService, adminGuard: AdminGuard) {
  const os = implement(walletContract).$context<OssContext>();

  return os.router({
    getBalance: os.getBalance.handler(({ context }) => wallet.getBalance(getUserId(context))),

    deposit: os.deposit.handler(({ input, context }) =>
      wallet.deposit(getUserId(context), input.amount, input.currency, input.provider),
    ),

    withdraw: os.withdraw.handler(({ input, context }) =>
      mapErrors(
        {
          NOT_FOUND: WalletNotFoundError,
          BAD_REQUEST: [InsufficientBalanceError, CurrencyMismatchError],
        },
        () => wallet.withdraw(getUserId(context), input.amount, input.currency, input.provider),
      ),
    ),

    listTransactions: os.listTransactions.handler(({ context }) =>
      wallet.getTransactions(getUserId(context)),
    ),

    withdrawals: {
      list: os.withdrawals.list.handler(async ({ input, context }) => {
        await adminGuard.assert(context, 'withdrawal', 'view');
        return wallet.listPendingWithdrawals(input);
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
  });
}

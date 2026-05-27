import { implement } from '@orpc/server';
import { getUserId, mapErrors, type OssContext } from '@oss/core';
import { walletContract } from '@oss/orpc-contract/wallet';
import {
  WalletService,
  WalletNotFoundError,
  InsufficientBalanceError,
} from '../service/wallet.service.js';

export function createWalletRouter(wallet: WalletService) {
  const os = implement(walletContract).$context<OssContext>();

  return os.router({
    getBalance: os.getBalance.handler(({ context }) => wallet.getBalance(getUserId(context))),

    deposit: os.deposit.handler(({ input, context }) =>
      wallet.deposit(getUserId(context), input.amount, input.currency, input.provider),
    ),

    withdraw: os.withdraw.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: WalletNotFoundError, BAD_REQUEST: InsufficientBalanceError }, () =>
        wallet.withdraw(getUserId(context), input.amount, input.currency, input.provider),
      ),
    ),

    listTransactions: os.listTransactions.handler(({ context }) =>
      wallet.getTransactions(getUserId(context)),
    ),
  });
}

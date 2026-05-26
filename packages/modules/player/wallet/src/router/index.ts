import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { getUserId, mapErrors } from '@oss/core';
import { walletContract } from '@oss/orpc-contract/wallet';
import {
  WalletService,
  WalletNotFoundError,
  InsufficientBalanceError,
} from '../service/wallet.service.js';

@Controller()
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Implement(walletContract)
  walletRoutes() {
    return {
      getBalance: implement(walletContract.getBalance).handler(({ context }) =>
        this.wallet.getBalance(getUserId(context)),
      ),

      deposit: implement(walletContract.deposit).handler(({ input, context }) =>
        this.wallet.deposit(getUserId(context), input.amount, input.currency, input.provider),
      ),

      withdraw: implement(walletContract.withdraw).handler(({ input, context }) =>
        mapErrors(
          { NOT_FOUND: WalletNotFoundError, BAD_REQUEST: InsufficientBalanceError },
          () => this.wallet.withdraw(getUserId(context), input.amount, input.currency, input.provider),
        ),
      ),

      listTransactions: implement(walletContract.listTransactions).handler(({ context }) =>
        this.wallet.getTransactions(getUserId(context)),
      ),
    };
  }
}

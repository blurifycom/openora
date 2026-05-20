import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import { walletContract } from '@oss/orpc-contract/wallet';
import {
  WalletService,
  WalletNotFoundError,
  InsufficientBalanceError,
} from '../service/wallet.service.js';

function getUserId(context: unknown): string {
  if (
    typeof context !== 'object' ||
    context === null ||
    !('request' in context) ||
    typeof (context as Record<string, unknown>).request !== 'object'
  ) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Missing request context' });
  }

  const req = (context as { request: { headers: Record<string, string | string[] | undefined> } })
    .request;
  const userId = req.headers['x-user-id'];
  const resolvedUserId = Array.isArray(userId) ? userId[0] : userId;

  if (!resolvedUserId) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Missing x-user-id header' });
  }

  return resolvedUserId;
}

@Controller()
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Implement(walletContract)
  walletRoutes() {
    return {
      getBalance: implement(walletContract.getBalance).handler(({ context }) => {
        const userId = getUserId(context);
        return this.wallet.getBalance(userId);
      }),

      deposit: implement(walletContract.deposit).handler(({ input, context }) => {
        const userId = getUserId(context);
        return this.wallet.deposit(userId, input.amount, input.currency, input.provider);
      }),

      withdraw: implement(walletContract.withdraw).handler(async ({ input, context }) => {
        const userId = getUserId(context);
        try {
          return await this.wallet.withdraw(userId, input.amount, input.currency, input.provider);
        } catch (err) {
          if (err instanceof WalletNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          if (err instanceof InsufficientBalanceError) {
            throw new ORPCError('BAD_REQUEST', { message: err.message });
          }
          throw err;
        }
      }),

      listTransactions: implement(walletContract.listTransactions).handler(({ context }) => {
        const userId = getUserId(context);
        return this.wallet.getTransactions(userId);
      }),
    };
  }
}

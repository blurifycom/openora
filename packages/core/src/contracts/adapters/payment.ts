// Payment seam. A PSP (card/bank/e-wallet) implements PaymentAdapter; bind a
// concrete adapter to PAYMENT_ADAPTER in the wallet module's plugin.ts.
import { createToken, type Token } from './token.js';

export type PaymentAdapter = {
  processDeposit(
    amount: string,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }>;

  processWithdrawal(
    amount: string,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }>;
};

export const PAYMENT_ADAPTER: Token<PaymentAdapter> = createToken('PAYMENT_ADAPTER');

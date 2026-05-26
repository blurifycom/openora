// Payment seam. A PSP (card/bank/e-wallet) implements PaymentAdapter; bind a
// concrete adapter to PAYMENT_ADAPTER in the wallet module's plugin.ts.

export interface PaymentAdapter {
  processDeposit(
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }>;

  processWithdrawal(
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }>;
}

export const PAYMENT_ADAPTER = Symbol('PAYMENT_ADAPTER');

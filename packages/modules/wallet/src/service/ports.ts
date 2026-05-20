export interface PaymentProvider {
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

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

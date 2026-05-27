import type { PaymentAdapter } from '@oss/adapters';

export class MockPaymentAdapter implements PaymentAdapter {
  async processDeposit(
    amount: number,
    currency: string,
    _metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }> {
    const externalId = `mock-deposit-${currency}-${amount}-${Date.now()}`;
    return { externalId, status: 'completed' };
  }

  async processWithdrawal(
    amount: number,
    currency: string,
    _metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }> {
    const externalId = `mock-withdrawal-${currency}-${amount}-${Date.now()}`;
    return { externalId, status: 'completed' };
  }
}

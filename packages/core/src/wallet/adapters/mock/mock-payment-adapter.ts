import type { PaymentAdapter } from '@openora/core/contracts';

export class MockPaymentAdapter implements PaymentAdapter {
  async processDeposit(amount: string, currency: string, _metadata: Record<string, unknown>) {
    const externalId = `mock-deposit-${currency}-${amount}-${Date.now()}`;
    return { externalId, status: 'completed' };
  }

  async processWithdrawal(amount: string, currency: string, _metadata: Record<string, unknown>) {
    const externalId = `mock-withdrawal-${currency}-${amount}-${Date.now()}`;
    return { externalId, status: 'completed' };
  }
}

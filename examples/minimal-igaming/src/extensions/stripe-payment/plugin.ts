import { definePlugin } from '@oss/plugin-host';
import { PAYMENT_ADAPTER, type PaymentAdapter } from '@oss/adapters';

// A consumer overlay that swaps the payment seam. The `wallet` module binds a default
// PaymentAdapter to PAYMENT_ADAPTER; because this overlay is listed AFTER `wallet` in
// extensions.config.ts, its binding is registered last and wins. This is the documented
// override path - no fork of `wallet` needed.
//
// The PaymentAdapter interface (processDeposit/processWithdrawal) lives in
// packages/contracts/adapters/src/payment.ts. Implement it against your PSP. This body
// is a stub that throws on use - it shows the seam, not a real Stripe integration.
class StripePaymentAdapter implements PaymentAdapter {
  async processDeposit(
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }> {
    void amount;
    void currency;
    void metadata;
    throw new Error('StripePaymentAdapter: configure STRIPE_KEY and implement processDeposit');
  }

  async processWithdrawal(
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<{ externalId: string; status: string }> {
    void amount;
    void currency;
    void metadata;
    throw new Error('StripePaymentAdapter: configure STRIPE_KEY and implement processWithdrawal');
  }
}

export default definePlugin({
  id: 'stripe-payment',
  // Optional: declare the dependency so the host orders us after wallet even if the
  // registry is reordered. Ordering still resolves correctly via list order too.
  dependsOn: ['wallet'],
  register(ctx) {
    // Rebind the token. useClass means Nest instantiates one StripePaymentAdapter and
    // injects it wherever PAYMENT_ADAPTER is requested (eg WalletService).
    ctx.providers.add({
      provide: PAYMENT_ADAPTER,
      useClass: StripePaymentAdapter,
    });
  },
});

import { randomUUID } from 'node:crypto';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  PAYMENT_ADAPTER,
  type PaymentAdapter,
  type PaymentWebhookEvent,
} from '@openora/core/contracts';

export const UNSUPPORTED_NETWORK = 'NOSUPPORT';
export const PAYOUT_DECIMALS = 2;

export default {
  id: 'testing-withdrawal-adapter',
  dependsOn: ['wallet', 'testing-payment-webhook'],
  register(ctx) {
    ctx.provide(
      PAYMENT_ADAPTER,
      () =>
        ({
          async processDeposit() {
            return { externalId: `test-${randomUUID()}`, status: 'completed' };
          },
          async processWithdrawal() {
            return { externalId: `test-${randomUUID()}`, status: 'completed' };
          },
          async issueDepositAddress(userId, currency) {
            return { address: `addr-${userId}-${currency}` };
          },
          withdrawalDecimals() {
            return PAYOUT_DECIMALS;
          },
          async whitelistWithdrawalAddress() {
            return { providerWalletId: `wl-${randomUUID()}` };
          },
          supportsAsset(_currency, network) {
            return network !== UNSUPPORTED_NETWORK;
          },
          parseWebhook(rawBody) {
            return JSON.parse(rawBody) as PaymentWebhookEvent;
          },
        }) satisfies PaymentAdapter,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

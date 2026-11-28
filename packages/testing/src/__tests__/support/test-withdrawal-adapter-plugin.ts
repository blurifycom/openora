import { randomUUID } from 'node:crypto';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PAYMENT_ADAPTER, type PaymentAdapter } from '@openora/core/contracts';
import { globalStore } from './global-store.js';
import { parseTestWebhook } from './payment-webhook-event.js';

type PayoutCall = { amount: string; currency: string; transactionId: string };

const PAYOUT_STORE = Symbol.for('openora.testing.withdrawal-payouts');
const isPayoutList = (value: unknown): value is PayoutCall[] => Array.isArray(value);
const payouts = globalStore(PAYOUT_STORE, isPayoutList, (): PayoutCall[] => []);

export const payoutsFor = (transactionId: string) =>
  payouts.filter((call) => call.transactionId === transactionId);

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
          async processWithdrawal(amount, currency, metadata) {
            const transactionId = metadata['transactionId'];
            if (typeof transactionId === 'string') {
              payouts.push({ amount, currency, transactionId });
            }
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
            return parseTestWebhook(rawBody);
          },
        }) satisfies PaymentAdapter,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

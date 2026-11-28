import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  PAYMENT_ADAPTER,
  PAYMENT_WEBHOOK_VERIFIER,
  type PaymentAdapter,
  type PaymentWebhookEvent,
} from '@openora/core/contracts';

const TEST_PAYMENT_WEBHOOK_KEY = 'test-payment-webhook-key';

export const TEST_PAYMENT_SIGNATURE_HEADER = 'x-test-payment-signature';

export const signTestPaymentWebhook = (rawBody: string) =>
  createHmac('sha256', TEST_PAYMENT_WEBHOOK_KEY).update(rawBody).digest('hex');

const TRANSACTIONS_STORE = Symbol.for('openora.testing.payment-transactions');
const holder = globalThis as typeof globalThis & {
  [TRANSACTIONS_STORE]?: { events: PaymentWebhookEvent[] };
};
const transactions = (holder[TRANSACTIONS_STORE] ??= { events: [] });

export const setTestPaymentTransactions = (events: PaymentWebhookEvent[]) => {
  transactions.events = events;
};

export default {
  id: 'testing-payment-webhook',
  dependsOn: ['wallet'],
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
          parseWebhook(rawBody) {
            return JSON.parse(rawBody) as PaymentWebhookEvent;
          },
          async listTransactions() {
            return transactions.events;
          },
        }) satisfies PaymentAdapter,
    );
    ctx.provide(PAYMENT_WEBHOOK_VERIFIER, () => ({
      verify(rawBody, headers) {
        const signature = headers[TEST_PAYMENT_SIGNATURE_HEADER];
        if (typeof signature !== 'string') {
          return false;
        }
        const expected = Buffer.from(signTestPaymentWebhook(rawBody));
        const actual = Buffer.from(signature);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;

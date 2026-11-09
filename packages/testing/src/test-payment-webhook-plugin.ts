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

/** The signature header value the fake vendor would send for `rawBody`. */
export const signTestPaymentWebhook = (rawBody: string) =>
  createHmac('sha256', TEST_PAYMENT_WEBHOOK_KEY).update(rawBody).digest('hex');

// On the process, not the module: the app loads this file as a separate module instance from
// the test that steers it.
const TRANSACTIONS_STORE = Symbol.for('openora.testing.payment-transactions');
const holder = globalThis as typeof globalThis & {
  [TRANSACTIONS_STORE]?: { events: PaymentWebhookEvent[] };
};
const transactions = (holder[TRANSACTIONS_STORE] ??= { events: [] });

/** What the fake vendor answers `listTransactions` with from now on. Default none. */
export const setTestPaymentTransactions = (events: PaymentWebhookEvent[]) => {
  transactions.events = events;
};

/**
 * Binds a fake address-based payment vendor to the default provider: a webhook body is the
 * normalized event itself, signed with `signTestPaymentWebhook`, and `listTransactions` answers
 * what `setTestPaymentTransactions` set. Opt-in only - pass it in `config.plugins`.
 */
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

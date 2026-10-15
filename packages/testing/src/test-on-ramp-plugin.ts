import { createHmac, timingSafeEqual } from 'node:crypto';
import { moneyScaleBy, type CoreTokenCatalog, type Plugin } from '@openora/core/server';
import {
  ON_RAMP_ADAPTER,
  ON_RAMP_WEBHOOK_VERIFIER,
  type OnRampAdapter,
  type OnRampCheckout,
} from '@openora/core/contracts';
import * as z from 'zod';

/** Units of crypto the fake vendor delivers per unit of fiat, whatever the pair. */
export const TEST_ON_RAMP_RATE = '0.5';

export const TEST_ON_RAMP_GATEWAY_ID = 'test-gateway';

export const TEST_ON_RAMP_WEBHOOK_SECRET = 'test-on-ramp-webhook-secret';

export const TEST_ON_RAMP_SIGNATURE_HEADER = 'x-test-on-ramp-signature';

/** The signature header value the fake vendor would send for `rawBody`. */
export const signTestOnRampWebhook = (rawBody: string) =>
  createHmac('sha256', TEST_ON_RAMP_WEBHOOK_SECRET).update(rawBody).digest('hex');

// The fake vendor's webhook body is the event itself, every field always sent.
const WebhookBodySchema = z.object({
  externalId: z.string().min(1),
  status: z.enum([
    'pending',
    'processing',
    'completed',
    'failed',
    'cancelled',
    'expired',
    'refunded',
  ]),
  walletAddress: z.string().min(1),
  cryptoAmount: z.string(),
  customerId: z.string(),
});

const parseJson = (rawBody: string): unknown => {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
};

/**
 * Binds a fake on-ramp vendor: EUR 20-5000 by card into USDT on TRC20, one gateway pricing at
 * `TEST_ON_RAMP_RATE`, a checkout deduped on its idempotency key, and an HMAC webhook signed
 * with `TEST_ON_RAMP_WEBHOOK_SECRET`. Opt-in only - pass it in `config.plugins`.
 */
export default {
  id: 'testing-on-ramp',
  dependsOn: ['wallet'],
  register(ctx) {
    const checkouts = new Map<string, OnRampCheckout>();
    ctx.provide(
      ON_RAMP_ADAPTER,
      () =>
        ({
          async getOptions() {
            return {
              fiats: [
                { code: 'EUR', minAmount: '20', maxAmount: '5000', paymentMethods: ['card'] },
              ],
              assets: [{ currency: 'USDT', network: 'TRC20' }],
            };
          },
          async getQuotes({ fiatCurrency, fiatAmount, currency, network }) {
            return [
              {
                gatewayId: TEST_ON_RAMP_GATEWAY_ID,
                gatewayName: 'Test Gateway',
                fiatCurrency,
                fiatAmount,
                currency,
                network,
                cryptoAmount: moneyScaleBy(fiatAmount, TEST_ON_RAMP_RATE),
                fee: '0',
                feeCurrency: fiatCurrency,
                rate: TEST_ON_RAMP_RATE,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            ];
          },
          async createCheckout({ idempotencyKey }) {
            const existing = checkouts.get(idempotencyKey);
            if (existing) {
              return existing;
            }
            const externalId = `test-${crypto.randomUUID()}`;
            const checkout = {
              externalId,
              checkoutUrl: `https://checkout.example.test/${externalId}`,
            };
            checkouts.set(idempotencyKey, checkout);
            return checkout;
          },
          parseWebhook(rawBody) {
            const parsed = WebhookBodySchema.safeParse(parseJson(rawBody));
            return parsed.success ? parsed.data : null;
          },
        }) satisfies OnRampAdapter,
    );
    ctx.provide(ON_RAMP_WEBHOOK_VERIFIER, () => ({
      verify(rawBody, headers) {
        const signature = headers[TEST_ON_RAMP_SIGNATURE_HEADER];
        if (typeof signature !== 'string') {
          return false;
        }
        const expected = Buffer.from(signTestOnRampWebhook(rawBody));
        const actual = Buffer.from(signature);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;

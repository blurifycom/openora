import { createHmac, timingSafeEqual } from 'node:crypto';
import { moneyScaleBy, type CoreTokenCatalog, type Plugin } from '@openora/core/server';
import {
  ON_RAMP_ADAPTER,
  ON_RAMP_WEBHOOK_VERIFIER,
  OnRampStatusSchema,
  type OnRampAdapter,
  type OnRampCheckout,
  type OnRampStatus,
} from '@openora/core/contracts';
import * as z from 'zod';

/** Units of crypto the fake vendor estimates per unit of fiat, whatever the pair. */
export const TEST_ON_RAMP_RATE = '0.5';

export const TEST_ON_RAMP_GATEWAY_ID = 'test-gateway';

export const TEST_ON_RAMP_WEBHOOK_SECRET = '[redacted]';

export const TEST_ON_RAMP_SIGNATURE_HEADER = 'x-test-on-ramp-signature';

/** The signature header value the fake vendor would send for `rawBody`. */
export const signTestOnRampWebhook = (rawBody: string) =>
  createHmac('sha256', TEST_ON_RAMP_WEBHOOK_SECRET).update(rawBody).digest('hex');

// On the process, not the module: the app loads this file as a separate module instance from
// the test that steers it.
const STATUS_STORE = Symbol.for('openora.testing.on-ramp-statuses');
const holder = globalThis as typeof globalThis & { [STATUS_STORE]?: Map<string, OnRampStatus> };
const statuses = (holder[STATUS_STORE] ??= new Map<string, OnRampStatus>());

/** What the fake vendor answers `getStatus(externalId)` with from now on. Default `pending`. */
export const setTestOnRampStatus = (externalId: string, status: OnRampStatus) => {
  statuses.set(externalId, status);
};

// The fake vendor's webhook body is the event itself.
const WebhookBodySchema = z.object({
  purchaseId: z.string().exactOptional(),
  externalId: z.string().min(1),
  status: OnRampStatusSchema,
  walletAddress: z.string().min(1).exactOptional(),
  walletTag: z.string().exactOptional(),
  externalCustomerId: z.string().exactOptional(),
  cryptoAmount: z.string().exactOptional(),
  txHash: z.string().exactOptional(),
  gatewayId: z.string().exactOptional(),
});

const parseJson = (rawBody: string): unknown => {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
};

/**
 * Binds a fake hosted-checkout on-ramp vendor: EUR 20-5000 into USDT on TRC20, one gateway
 * estimating at `TEST_ON_RAMP_RATE`, a checkout deduped on its idempotency key, a status set by
 * `setTestOnRampStatus`, and an HMAC webhook signed with `TEST_ON_RAMP_WEBHOOK_SECRET`. Opt-in
 * only - pass it in `config.plugins`.
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
              fiats: [{ code: 'EUR', minAmount: '20', maxAmount: '5000' }],
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
          async getStatus(externalId) {
            return statuses.get(externalId) ?? 'pending';
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

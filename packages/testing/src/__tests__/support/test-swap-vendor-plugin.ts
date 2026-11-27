import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  moneyCompare,
  moneyScaleBy,
  type CoreTokenCatalog,
  type Plugin,
} from '@openora/core/server';
import {
  SWAP_ADAPTER,
  SWAP_WEBHOOK_VERIFIER,
  type SwapAdapter,
  type SwapWebhookEvent,
} from '@openora/core/contracts';

export const SWAP_VENDOR_RATE = '2';
export const SWAP_VENDOR_ASYNC_AMOUNT = '3';
export const SWAP_VENDOR_REJECTED_AMOUNT = '7';
export const SWAP_VENDOR_UNSUPPORTED_CURRENCY = 'NOPAIR';
export const SWAP_VENDOR_SIGNATURE_HEADER = 'x-test-swap-signature';

const SECRET = 'swap-vendor-secret';

export const signSwapWebhook = (rawBody: string) =>
  createHmac('sha256', SECRET).update(rawBody).digest('hex');

const parseEvent = (rawBody: string): SwapWebhookEvent | null => {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { kind, externalId, status, toAmount } = parsed as Record<string, unknown>;
    if (
      kind !== 'swap' ||
      typeof externalId !== 'string' ||
      (status !== 'completed' && status !== 'failed' && status !== 'processing')
    ) {
      return null;
    }
    return {
      kind,
      externalId,
      status,
      ...(typeof toAmount === 'string' ? { toAmount } : {}),
    };
  } catch {
    return null;
  }
};

export default {
  id: 'testing-swap-vendor',
  dependsOn: ['wallet'],
  register(ctx) {
    ctx.provide(
      SWAP_ADAPTER,
      () =>
        ({
          supportsPair: (from, to) =>
            from !== SWAP_VENDOR_UNSUPPORTED_CURRENCY && to !== SWAP_VENDOR_UNSUPPORTED_CURRENCY,
          async getQuote({ fromCurrency, toCurrency, fromAmount }) {
            const now = Date.now();
            return {
              quoteId: `quote-${crypto.randomUUID()}`,
              fromCurrency,
              toCurrency,
              fromAmount,
              toAmount: moneyScaleBy(fromAmount, SWAP_VENDOR_RATE),
              rate: SWAP_VENDOR_RATE,
              fee: '0',
              feeCurrency: toCurrency,
              asOf: new Date(now).toISOString(),
              expiresAt: new Date(now + 30_000).toISOString(),
            };
          },
          async execute({ fromAmount, idempotencyKey }) {
            if (moneyCompare(fromAmount, SWAP_VENDOR_REJECTED_AMOUNT) === 0) {
              return { externalId: idempotencyKey, status: 'failed' };
            }
            if (moneyCompare(fromAmount, SWAP_VENDOR_ASYNC_AMOUNT) === 0) {
              return { externalId: idempotencyKey, status: 'processing' };
            }
            return {
              externalId: idempotencyKey,
              status: 'completed',
              toAmount: moneyScaleBy(fromAmount, SWAP_VENDOR_RATE),
            };
          },
          parseWebhook: (rawBody) => parseEvent(rawBody),
        }) satisfies SwapAdapter,
    );
    ctx.provide(SWAP_WEBHOOK_VERIFIER, () => ({
      verify(rawBody, headers) {
        const signature = headers[SWAP_VENDOR_SIGNATURE_HEADER];
        if (typeof signature !== 'string') {
          return false;
        }
        const expected = Buffer.from(signSwapWebhook(rawBody));
        const actual = Buffer.from(signature);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;

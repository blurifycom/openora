import {
  moneyCompare,
  moneyScaleBy,
  type CoreTokenCatalog,
  type Plugin,
} from '@openora/core/server';
import {
  SWAP_ADAPTER,
  SwapLimitExceededError,
  SwapRefusedError,
  type SwapAdapter,
} from '@openora/core/contracts';

export const TEST_SWAP_DESK_RATE = '50000';

export const TEST_SWAP_DESK_LIMIT = '1';

export default {
  id: 'testing-swap-desk',
  dependsOn: ['wallet'],
  register(ctx) {
    const issued = new Map<string, string>();
    const spent = new Set<string>();
    ctx.provide(
      SWAP_ADAPTER,
      () =>
        ({
          async getQuote({ fromCurrency, toCurrency, fromAmount }) {
            if (moneyCompare(fromAmount, TEST_SWAP_DESK_LIMIT) > 0) {
              throw new SwapLimitExceededError('over_swap_limit', 'Swap exceeds the desk limit');
            }
            const quoteId = `test-${crypto.randomUUID()}`;
            const toAmount = moneyScaleBy(fromAmount, TEST_SWAP_DESK_RATE);
            issued.set(quoteId, toAmount);
            const now = Date.now();
            return {
              quoteId,
              fromCurrency,
              toCurrency,
              fromAmount,
              toAmount,
              rate: TEST_SWAP_DESK_RATE,
              fee: '0',
              feeCurrency: toCurrency,
              asOf: new Date(now).toISOString(),
              expiresAt: new Date(now + 30_000).toISOString(),
            };
          },
          async execute({ quoteId, idempotencyKey }) {
            const toAmount = quoteId ? issued.get(quoteId) : undefined;
            if (!quoteId || !toAmount) {
              throw new SwapRefusedError('quote_invalid', 'Unknown swap quote');
            }
            if (spent.has(quoteId)) {
              throw new SwapRefusedError('quote_spent', 'Swap quote already filled');
            }
            spent.add(quoteId);
            return { externalId: idempotencyKey, status: 'completed', toAmount };
          },
        }) satisfies SwapAdapter,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

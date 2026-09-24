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

/** Units of the target currency the desk pays per unit of the source, whatever the pair. */
export const TEST_SWAP_DESK_RATE = '50000';

/** Largest swap the desk quotes, in units of the source currency. */
export const TEST_SWAP_DESK_LIMIT = '1';

/**
 * Binds a synchronous swap desk that fills at `TEST_SWAP_DESK_RATE`, refuses a quote above
 * `TEST_SWAP_DESK_LIMIT` and fills each quote once, so a test can prove the typed refusals
 * reach the caller as 4xx. Opt-in only - pass it in `config.plugins`.
 */
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

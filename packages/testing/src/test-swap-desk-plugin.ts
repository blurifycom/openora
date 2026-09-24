import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  SWAP_ADAPTER,
  SwapLimitExceededError,
  SwapRefusedError,
  type SwapAdapter,
} from '@openora/core/contracts';

/** Largest swap the desk quotes, so a test can cross it. */
export const TEST_SWAP_DESK_LIMIT = 100;

/**
 * Binds a synchronous swap desk that fills 1:1, refuses a quote above
 * `TEST_SWAP_DESK_LIMIT` and fills each quote once, so a test can prove the typed
 * refusals reach the caller as 4xx. Opt-in only - pass it in `config.plugins`.
 */
export default {
  id: 'testing-swap-desk',
  dependsOn: ['wallet'],
  register(ctx) {
    const issued = new Set<string>();
    const spent = new Set<string>();
    ctx.provide(
      SWAP_ADAPTER,
      () =>
        ({
          async getQuote({ fromCurrency, toCurrency, fromAmount }) {
            if (Number(fromAmount) > TEST_SWAP_DESK_LIMIT) {
              throw new SwapLimitExceededError('over_swap_limit', 'Swap exceeds the desk limit');
            }
            const quoteId = `test-${crypto.randomUUID()}`;
            issued.add(quoteId);
            const now = Date.now();
            return {
              quoteId,
              fromCurrency,
              toCurrency,
              fromAmount,
              toAmount: fromAmount,
              rate: '1',
              fee: '0',
              feeCurrency: toCurrency,
              asOf: new Date(now).toISOString(),
              expiresAt: new Date(now + 30_000).toISOString(),
            };
          },
          async execute({ quoteId, fromAmount, idempotencyKey }) {
            if (!quoteId || !issued.has(quoteId)) {
              throw new SwapRefusedError('quote_invalid', 'Unknown swap quote');
            }
            if (spent.has(quoteId)) {
              throw new SwapRefusedError('quote_spent', 'Swap quote already filled');
            }
            spent.add(quoteId);
            return { externalId: idempotencyKey, status: 'completed', toAmount: fromAmount };
          },
        }) satisfies SwapAdapter,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

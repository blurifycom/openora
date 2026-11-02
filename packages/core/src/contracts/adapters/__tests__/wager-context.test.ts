import { describe, expect, it } from 'vitest';
import {
  WAGER_PRODUCTS,
  wagerProductOfProviderName,
  wagerProductProviderPrefix,
} from '../wager-context.js';

describe('wagerProductOfProviderName', () => {
  it.each(WAGER_PRODUCTS)('reads %s back from its own prefix', (product) => {
    expect(wagerProductOfProviderName(`${wagerProductProviderPrefix(product)}vendor`)).toBe(
      product,
    );
  });

  it.each([null, '', 'vendor', ':vendor', 'lottery:vendor', 'Sportsbook:vendor', 'sportsbook'])(
    'names no product for %j',
    (providerName) => {
      expect(wagerProductOfProviderName(providerName)).toBeNull();
    },
  );
});

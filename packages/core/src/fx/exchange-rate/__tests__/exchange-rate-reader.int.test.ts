import { describe, it } from 'vitest';

describe('exchange-rate provider selection', () => {
  it.todo('asks the crypto provider for a crypto currency and the fiat provider for a fiat one');
  it.todo('answers no quote when the provider for the rail is not bound');
});

describe('exchange-rate freshness', () => {
  it.todo('serves a fresh cached quote without calling the provider');
  it.todo('serves a soft-stale quote and refreshes it in the background');
  it.todo('fetches from the provider when the quote is hard-stale or missing');
  it.todo('answers no quote when the provider fails and the stored quote is hard-stale');
  it.todo('answers no quote when the provider times out');
  it.todo(
    'rejects a provider quote whose time is further in the future than the allowed clock skew',
  );
  it.todo('rejects a provider rate above the plausible upper bound or not positive');
  it.todo('derives the rate between two non-pivot currencies through the pivot');
  it.todo('returns rate one for the same currency');
});

describe('concurrent exchange-rate reads', () => {
  it.todo('many parallel reads of one cold pair call the provider once');
});

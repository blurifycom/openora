import { describe, it } from 'vitest';

describe('player swap', () => {
  it.todo('a player requesting a swap quote gets the rate and amounts for a supported pair');
  it.todo(
    'a player executing a swap moves both balances with one ledger row per leg and applies once on a repeated request',
  );
  it.todo('a swap for an unsupported pair is refused and balances are unchanged');
  it.todo('a swap larger than the balance is refused and balances are unchanged');
  it.todo('a swap when no swap desk is available is refused as unavailable');
  it.todo('a swap webhook with an invalid signature is rejected and changes nothing');
  it.todo('an unauthenticated caller requesting a swap is refused with 401');
});

describe('player on-ramp purchase', () => {
  it.todo(
    'a player reading on-ramp options and quote gets the available providers and the priced quote',
  );
  it.todo('a player starting an on-ramp checkout gets an order they can read back');
  it.todo("a player reading another player's on-ramp order is refused as not found");
  it.todo('an on-ramp checkout from a restricted player is refused');
  it.todo('an on-ramp checkout from a geo-blocked location is refused');
  it.todo('an on-ramp checkout when no provider is available is refused as unavailable');
  it.todo(
    'an on-ramp completion webhook credits the balance once and a repeated webhook changes nothing',
  );
  it.todo('an on-ramp webhook with an invalid signature is rejected and credits nothing');
});

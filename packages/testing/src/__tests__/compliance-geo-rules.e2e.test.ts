import { describe, it } from 'vitest';

describe('Country blacklist at registration, login and betting', () => {
  it.todo('player from a blacklisted country cannot register and no account is created');
  it.todo('player from an allowed country registers');
  it.todo('existing player logging in from a blacklisted country is refused');
  it.todo(
    'player placing a bet from a blacklisted country is refused and the balance is unchanged',
  );
  it.todo('player launching a game that is restricted for their country is refused');
  it.todo('removing a country from the blacklist lets the player in on the next request');
  it.todo(
    'a blacklisted country with a mirror redirect target is reported as redirected, not blocked',
  );
  it.todo('a blacklist rule with the redirect flag but an empty mirror target still blocks');
  it.todo('geo check with an unresolvable country blocks instead of letting the player through');
  it.todo('geo check when the geo lookup provider fails blocks instead of failing open');
  it.todo('geo check with a missing or spoofed forwarded address does not grant access');
  it.todo('player geo-check route returns the effective access for the caller country');
});

describe('Geo rule administration', () => {
  it.todo('admin blacklists a country and the rule is listed with the audit row');
  it.todo('admin cannot blacklist a licensed jurisdiction and gets a conflict');
  it.todo('admin saving a rule that changes access without confirmation is asked to confirm');
  it.todo('admin saving a country rule with a stale version gets a version conflict');
  it.todo('admin sets a mirror target that is not approved and is refused');
  it.todo('admin restricts and unrestricts a game for a country, then reads the rule list');
  it.todo('admin bulk-restricts games and providers and a missing country code is reported');
  it.todo('admin sets and removes a provider geo rule and a missing provider returns not found');
  it.todo('player and anonymous callers cannot read or write geo rules');
});

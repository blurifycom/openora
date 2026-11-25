import { describe, it } from 'vitest';

describe('player deposit address and crediting', () => {
  it.todo(
    'a player requests a deposit address and gets one unique address per currency and network',
  );
  it.todo('two different players requesting the same currency and network get different addresses');
  it.todo('the same player requesting the same address twice gets the same address back');
  it.todo(
    'a player requesting an address for a currency or network the catalog does not offer is refused',
  );
  it.todo('a player requesting an address for a network with deposits switched off is refused');
  it.todo('a player with an ambiguous currency and no network named is refused as ambiguous');
  it.todo('an unauthenticated caller requesting a deposit address is refused with 401');
  it.todo(
    'a deposit webhook below the asset minimum is not credited, leaves the balance unchanged and files one below-minimum finding',
  );
  it.todo(
    'a deposit webhook for an unconfirmed transfer records it pending and leaves the balance unchanged',
  );
  it.todo(
    'a confirmed deposit webhook credits the balance once and writes one ledger row with the reference value and stored rate',
  );
  it.todo(
    'the same confirmed deposit webhook delivered twice credits the balance once and writes one ledger row',
  );
  it.todo('the same confirmed deposit webhook delivered concurrently credits the balance once');
  it.todo('a deposit webhook with an invalid signature is rejected and credits nothing');
  it.todo(
    'a deposit webhook with a malformed amount or empty id answers an error so the vendor retries, and credits nothing',
  );
  it.todo('a deposit webhook for an unknown address credits no player');
  it.todo(
    'a deposit webhook with no fresh exchange rate writes no row and answers an error so the vendor redelivers',
  );
  it.todo('a deposit by a player barred from depositing is held and not credited until released');
  it.todo(
    'an admin crediting a held or below-minimum deposit finding credits the balance once and a second attempt is refused',
  );
  it.todo(
    'an admin refunding a below-minimum deposit finding leaves the balance unchanged and records the refund once',
  );
  it.todo(
    'a player deposit over the responsible-gambling deposit limit is refused and writes no ledger row',
  );
});

import { describe, it } from 'vitest';

describe('player withdrawal request', () => {
  it.todo(
    'a player withdrawing below the auto threshold is paid out automatically and the withdrawal completes with a debit ledger row',
  );
  it.todo(
    'a player withdrawing above the auto threshold waits in the admin queue and is debited at request time',
  );
  it.todo(
    'a withdrawal threshold in another currency is evaluated in the reference currency at the stored rate',
  );
  it.todo('a withdrawal below the asset minimum is refused and the balance is unchanged');
  it.todo('a withdrawal not above the network fee is refused and the balance is unchanged');
  it.todo(
    'a withdrawal with more decimals than the asset allows is refused and the balance is unchanged',
  );
  it.todo('a withdrawal larger than the balance is refused and the balance never goes negative');
  it.todo(
    'two concurrent withdrawals that together exceed the balance debit once and refuse the other',
  );
  it.todo(
    'a repeated withdrawal request with the same idempotency key debits once and returns the same withdrawal',
  );
  it.todo(
    'the same idempotency key reused with a different amount or currency is refused as key reuse',
  );
  it.todo('a withdrawal with no fresh exchange rate is refused and nothing is debited');
  it.todo('a withdrawal for a currency or network with withdrawals switched off is refused');
  it.todo(
    'a withdrawal before the 1x wagering on the deposit is met is refused and the balance is unchanged',
  );
  it.todo('a withdrawal after the 1x wagering on the deposit is met is accepted');
  it.todo(
    'a withdrawal that needs KYC from an unverified player is refused and the balance is unchanged',
  );
  it.todo(
    'a withdrawal from a player with a withdrawal lock waits unapproved until the lock is released',
  );
  it.todo(
    'a withdrawal from a player held by another module cannot be approved until the hold releases',
  );
  it.todo('an unauthenticated caller requesting a withdrawal is refused with 401');
  it.todo("a player cannot see or act on another player's withdrawal");
});

describe('withdrawal PIN', () => {
  it.todo('a player with a PIN withdrawing without the PIN is refused and nothing is debited');
  it.todo(
    'a player withdrawing with a wrong PIN is refused with the attempts left and nothing is debited',
  );
  it.todo(
    'five wrong PIN attempts lock withdrawals for 30 minutes and a correct PIN is refused while locked',
  );
  it.todo(
    'a correct PIN after fewer than five wrong attempts resets the attempt counter and the withdrawal succeeds',
  );
  it.todo('a player without a PIN can withdraw without one');
  it.todo('the PIN lock expires after 30 minutes and a correct PIN works again');
});

describe('withdrawal addresses', () => {
  it.todo('a player saving a withdrawal address sees it usable only 24 hours after it was saved');
  it.todo(
    'a withdrawal to an address saved less than 24 hours ago is refused as cooling down and nothing is debited',
  );
  it.todo('a withdrawal to an address saved more than 24 hours ago is accepted');
  it.todo('a withdrawal to an address that is not saved is refused when the whitelist is required');
  it.todo('saving a malformed address for a network is refused');
  it.todo('saving the same address twice for the same network is refused as already existing');
  it.todo('saving more addresses than the per-player limit is refused');
  it.todo("a player cannot list or delete another player's withdrawal address");
  it.todo('a player deleting their address cannot withdraw to it afterwards');
});

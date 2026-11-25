import { describe, it } from 'vitest';

describe('player opts in and receives a deposit bonus', () => {
  it.todo(
    'a player opts in to an active offer and a later deposit at or above the minimum creates an active grant with the matched amount and wagering requirement',
  );
  it.todo('a deposit below the minimum deposit creates no grant and the opt-in stays open');
  it.todo('a deposit in a currency other than the offer currency creates no grant');
  it.todo('opting in to an inactive, expired or unknown offer is refused');
  it.todo('opting in twice to the same offer does not create a second slot');
  it.todo('a deposit event delivered twice creates exactly one grant');
  it.todo('a first-deposit-only offer grants nothing on a second deposit');
  it.todo('opting in without a session is rejected as unauthorized');
  it.todo(
    'the public offers list shows only active offers to a visitor and nothing to a refused country',
  );
});

describe('player reads and activates grants', () => {
  it.todo("the player grant list and grant detail return only the caller's grants");
  it.todo("reading another player's grant by id returns not found");
  it.todo('activating a pending grant moves it to active and records an entry');
  it.todo('activating a grant twice leaves a single activation entry');
  it.todo('activating a grant owned by another player is refused');
  it.todo('the balance read returns real and bonus balances separately per currency');
});

describe('admin manages offers, weights and forfeits', () => {
  it.todo('an admin creates an offer with unique key and terms and the creation is audited');
  it.todo('creating an offer with a key already in use is refused with a conflict');
  it.todo('updating the terms of an offer that already has grants is refused as claimed');
  it.todo('an offer with contradictory max bet terms is refused as invalid terms');
  it.todo('an admin sets a game weight and the contribution rate applies to later bets only');
  it.todo(
    'an admin forfeits an active grant, the bonus balance is removed and the forfeit is audited',
  );
  it.todo(
    'forfeiting a grant that is already closed is refused with a conflict and leaves balances unchanged',
  );
  it.todo('a non-admin calling any admin offer, weight or grant route is refused as forbidden');
});

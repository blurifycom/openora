import { describe, it } from 'vitest';

describe('player launches a game and plays a round', () => {
  it.todo(
    'a signed-in player starts a round on an active game and receives a launch URL and a round row in the started state',
  );
  it.todo(
    'starting a round whose provider launch fails returns an error and writes no ledger transaction and no round row',
  );
  it.todo(
    'starting a round on an inactive or unknown game is refused and leaves the balance unchanged',
  );
  it.todo(
    'starting a round from a geo-restricted country is refused with the geo error and no round row',
  );
  it.todo('a player with a self-excluded or closed account cannot start a round');
  it.todo('starting a round without a session is rejected as unauthorized');
  it.todo(
    'the bet is debited from the wallet before the round stake is accepted and the balance drops by exactly the stake',
  );
  it.todo(
    'a bet larger than the available balance is refused and neither the round nor the ledger changes',
  );
  it.todo('ending a round with a valid win amount credits the win once and marks the round ended');
  it.todo('ending the same round twice credits the win only once');
  it.todo(
    'ending a round with a negative or non-numeric win amount is refused and credits nothing',
  );
  it.todo('a player cannot end a round that belongs to another player');
  it.todo(
    'rolling back or voiding a round restores the stake exactly once and a repeated rollback changes nothing',
  );
  it.todo("the player round list returns only the caller's rounds in newest-first order");
});

describe('player favourites and catalog reads', () => {
  it.todo('a player adds a game to favourites and it appears in the favourites list and id list');
  it.todo('adding the same favourite twice keeps a single row');
  it.todo(
    "removing a favourite that is not set is a no-op for the caller and never touches another player's favourites",
  );
  it.todo('listing favourites without a session is rejected as unauthorized');
  it.todo(
    'listing games filters by provider, category and search term and never returns inactive games',
  );
  it.todo('getting a game by an unknown slug returns not found');
});

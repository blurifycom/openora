import { describe, it } from 'vitest';

describe('player sportsbook session and bets', () => {
  it.todo('a player requests a sportsbook session and receives a token bound to that player');
  it.todo('a player with a closed, excluded or restricted account is refused a session');
  it.todo('revoking a session makes its token unusable');
  it.todo("the own bet list and bet detail return only the caller's bets");
  it.todo("reading another player's bet by id or transaction returns not found");
  it.todo('availability reports unavailable while the sportsbook is suspended');
  it.todo('session issue without a login is rejected as unauthorized');
});

describe('admin sportsbook operations', () => {
  it.todo('an admin lists and reads bets of any player');
  it.todo('an admin aligns a bet with the provider state and the change is audited');
  it.todo(
    'an admin updates the config and suspends then resumes the sportsbook and each action is audited',
  );
  it.todo(
    "an admin restricts and lifts a restriction on a player and the player's session requests follow",
  );
  it.todo('an admin lists findings and resolves one, and resolving twice is refused');
  it.todo('collecting or writing off a debt changes its status once and a repeat is refused');
  it.todo('the promotion report flags a payout out of the usual range for the promotion');
  it.todo('a non-admin calling any admin sportsbook route is refused as forbidden');
});

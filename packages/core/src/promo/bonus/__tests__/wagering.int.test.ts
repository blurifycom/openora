import { describe, it } from 'vitest';

describe('bonus wagering on bets', () => {
  it.todo(
    "a bet on an eligible game advances the requirement by the stake at the game's contribution rate",
  );
  it.todo('a bet on a game with no weight advances nothing');
  it.todo('a bet above the max bet while a bonus is active is refused');
  it.todo('a bet exactly at the max bet is accepted');
  it.todo('the stake is taken from bonus funds first and real funds after according to the grant');
  it.todo('completing the requirement converts the remaining bonus balance to cash once');
  it.todo('a win while wagering credits the bonus balance and not the real balance');
  it.todo('a rolled-back round returns the stake and its wagering progress');
  it.todo('a repeated bet with the same round id advances the requirement once');
  it.todo('two grants in rollover order each receive the progress they have room for');
});

describe('grant lifecycle jobs', () => {
  it.todo('the expiry job closes grants past their expiry and removes their bonus balance');
  it.todo('the expiry job leaves active grants not yet due untouched');
  it.todo('running the expiry job twice closes each grant once');
  it.todo('self-exclusion of a player forfeits all of their active grants');
  it.todo('a ban of a player forfeits all of their active grants and records the reason');
  it.todo('a forfeit job retried after a partial run forfeits only the grants still active');
  it.todo('the deposit job grants the bonus once when the transaction is delivered twice');
});

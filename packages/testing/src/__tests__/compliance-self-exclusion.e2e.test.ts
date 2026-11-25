import { describe, it } from 'vitest';

describe('Cooling-off', () => {
  it.todo('player starts a cooling-off period and cannot deposit or bet until it ends');
  it.todo('player in cooling-off cannot lift it early');
  it.todo('cooling-off with a duration outside the allowed range is refused');
  it.todo('player starts cooling-off twice and gets an active-exclusion conflict');
  it.todo('cooling-off ends on its own once the period has elapsed and the player plays again');
  it.todo('admin lifts a cooling-off period and the lift is audited');
});

describe('Self-exclusion', () => {
  it.todo('player self-excludes and every active session is ended at once');
  it.todo('player self-excluded cannot log in, deposit or bet');
  it.todo(
    'self-exclusion forfeits every active bonus and the bonus balance is zeroed with a ledger row',
  );
  it.todo('self-exclusion keeps real-money balance withdrawable');
  it.todo('permanent self-exclusion cannot be lifted by an admin');
  it.todo('admin lifting a fixed-period self-exclusion before it elapsed is refused');
  it.todo('admin lifting a self-exclusion after its period elapsed reopens the account');
  it.todo('player self-excludes twice and gets an active-exclusion conflict');
  it.todo('player cannot start or lift an exclusion for another player');
  it.todo('self-exclusion and cooling-off are listed in the player rg history with dates');
});

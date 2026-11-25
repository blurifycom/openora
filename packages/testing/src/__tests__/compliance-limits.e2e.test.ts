import { describe, it } from 'vitest';

describe('Player deposit, loss and wager limits', () => {
  it.todo('player sets a daily deposit limit and a deposit over it is refused');
  it.todo('player sets weekly and monthly limits and the tightest window refuses first');
  it.todo('player sets a loss limit and a bet that would exceed it is refused');
  it.todo('player sets a wager limit and the next bet over it is refused');
  it.todo(
    'limits of the same type must stay ordered from daily to monthly or the write is refused',
  );
  it.todo('a limit set in one currency does not apply to a twin currency and the write is refused');
  it.todo('player lowers a limit and it applies on the next request');
  it.todo('player raises a limit and the old value stays enforced until the cool-down elapses');
  it.todo('player confirming a raise before the cool-down elapsed gets a cool-down error');
  it.todo('player confirming a raise after the confirmation window lapsed gets an expired error');
  it.todo('player confirms a raised limit after the cool-down and the new value applies');
  it.todo('player cancels a pending raise and the current limit stays');
  it.todo('player cannot confirm or cancel another player pending change');
  it.todo('player removes a limit and cannot remove another player limit');
  it.todo('a spent window resets at the window boundary and the player can deposit again');
  it.todo('player at the flag threshold of a limit is flagged for responsible gambling review');
});

describe('Admin limit changes and projection', () => {
  it.todo('admin lowers a player limit and it applies at once');
  it.todo('admin cannot raise a player limit and gets a raise-not-allowed error');
  it.todo('admin cannot remove a player limit that would raise the effective cap');
  it.todo('player cannot use the admin limit route');
  it.todo('every limit change bumps the limit projection version and emits the changed event');
  it.todo('limit projection for a player lists each active limit with its period and currency');
  it.todo(
    'concurrent limit changes for one player produce strictly increasing projection versions',
  );
  it.todo('player reads own responsible-gambling section with limits and pending changes');
});

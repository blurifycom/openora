import { describe, it } from 'vitest';

describe('player daily streak', () => {
  it.todo('a qualifying bet today starts a streak of one day and the player streak view shows it');
  it.todo('a second qualifying bet on the same UTC day does not advance the streak');
  it.todo('a qualifying bet on the next UTC day advances the streak by one');
  it.todo('a missed UTC day resets the streak to zero on the daily close');
  it.todo('a bet just before and just after UTC midnight counts as two days');
  it.todo('claiming a reached milestone credits the reward once');
  it.todo('claiming the same milestone twice is refused and credits nothing');
  it.todo('claiming a milestone not yet reached is refused as not claimable');
  it.todo(
    'claiming when the payout currency rate is unavailable is refused as service unavailable',
  );
  it.todo('claiming without a session is rejected as unauthorized');
  it.todo('the streak leaderboard lists players by streak length without exposing private data');
});

describe('admin streak configuration', () => {
  it.todo('an admin sets the streak config and the player view reflects the new milestones');
  it.todo('a non-admin setting the streak config is refused as forbidden');
});

import { describe, it } from 'vitest';

describe('player races', () => {
  it.todo('the active race list returns only races inside their window');
  it.todo('wagering during a race moves the player up the leaderboard');
  it.todo('reading a race that does not exist returns not found');
  it.todo('a race without a bonus reports positions and pays nothing in bonus funds');
  it.todo('a closed race pays its prizes once and a second close pays nothing');
  it.todo('the leaderboard returns only public player fields');
});

describe('admin races', () => {
  it.todo('an admin creates a race and the creation is audited');
  it.todo('creating a race with invalid prize positions is refused as bad request');
  it.todo('updating a closed race is refused with a conflict');
  it.todo('reading an unknown race as admin returns not found');
  it.todo('a non-admin calling any admin race route is refused as forbidden');
});

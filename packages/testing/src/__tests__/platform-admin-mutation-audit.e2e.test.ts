import { describe, it } from 'vitest';

describe('admin mutation audit fallback', () => {
  it.todo(
    'an admin mutation that writes no audit row leaves one admin resource action row with the route and actor',
  );
  it.todo('an admin mutation that writes its own audit row leaves no second row');
  it.todo('a failed admin mutation leaves a failure audit row for the actor');
  it.todo('an admin read leaves no audit row');
  it.todo('a player calling an admin mutation is refused and leaves no admin audit row');
});

import { describe, it } from 'vitest';

describe('holdsGrant', () => {
  it.todo('a role name outside the static table holds nothing');
  it.todo('a user with database grants holds exactly those grants');
  it.todo('a user with database grants does not fall back to the static role table');
  it.todo('a user with no database assignment falls back to the static role of the user');
  it.todo('a grant for another resource or action is not held');
});

describe('isRoleName', () => {
  it.todo('accepts the defined role names');
  it.todo('rejects inherited object keys such as constructor');
});

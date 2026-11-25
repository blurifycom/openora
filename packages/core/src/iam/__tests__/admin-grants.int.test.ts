import { describe, it } from 'vitest';

describe('loadAdminGrants', () => {
  it.todo('a super admin role yields every grant of every resource');
  it.todo('two roles yield the union of their grants without duplicates');
  it.todo('a user with no assignment is absent from the result');
  it.todo('a no_access cell yields no grant');
});

describe('super admin retention', () => {
  it.todo('only active admin accounts count as super admin holdings');
  it.todo('a deactivated or player account holding the super admin role does not count');
});

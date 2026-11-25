import { describe, it } from 'vitest';

describe('effective country access', () => {
  it.todo('a deployment-blocked country is blocked regardless of the rule');
  it.todo('a blacklisted country without redirect is blocked');
  it.todo('a blacklisted country with redirect and a mirror target is redirected');
  it.todo('a blacklisted country with redirect and an empty mirror target is blocked');
  it.todo('a blacklisted country with redirect and a null mirror target is blocked');
  it.todo('a country that is not blacklisted with a mirror target is redirected');
  it.todo('a country that is not blacklisted and has no redirect is open');
});

describe('country rule change detection', () => {
  it.todo('a rule saved with identical values has no changes');
  it.todo('a changed access field is a change that needs confirmation');
  it.todo('a money field compared as equal strings or both null is not a change');
  it.todo('an expected version that differs from the stored update time is a conflict');
  it.todo('an absent expected version never conflicts');
});

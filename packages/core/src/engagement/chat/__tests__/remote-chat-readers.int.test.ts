import { describe, it } from 'vitest';

describe('remote account reader', () => {
  it.todo('a resolved account is returned and the second read is served from cache');
  it.todo('a remote failure is logged and the reader fails closed');
  it.todo('a missing account is not cached as present');
});

describe('remote session resolver', () => {
  it.todo('a valid session resolves to the player and is cached');
  it.todo('an invalid session resolves to null');
  it.todo('a remote failure is logged and resolves to no session');
});

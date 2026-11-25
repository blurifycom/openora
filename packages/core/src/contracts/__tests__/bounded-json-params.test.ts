import { describe, it } from 'vitest';

describe('fitsJsonBytes', () => {
  it.todo('accepts a value of exactly the byte limit');
  it.todo('refuses a value one byte over the limit');
  it.todo('counts multi-byte characters as bytes not characters');
});

describe('createBoundedJsonParamsSchema', () => {
  it.todo('accepts a record within the limit');
  it.todo('refuses an empty key or a key over 64 characters');
  it.todo('refuses a record over the limit with the labelled message');
  it.todo('refuses a value that is not JSON');
});

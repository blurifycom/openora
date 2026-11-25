import { describe, it } from 'vitest';

describe('canonical hash input', () => {
  it.todo('the same before and after with different key order hash the same');
  it.todo('nested objects are key-sorted but array order is kept');
  it.todo('a missing before or after hashes as null');
  it.todo('a missing previous hash hashes as an empty string');
  it.todo('changing any hashed field changes the hash');
  it.todo('the hash is a 64 character lowercase hex sha256');
});

describe('day bounds', () => {
  it.todo('start of day is midnight UTC of the given date');
  it.todo('end of day is 23:59:59.999 UTC of the given date');
  it.todo('a date with a time part and offset resolves to the UTC day');
  it.todo('the bounds of the last day of a month and a leap day are correct');
});

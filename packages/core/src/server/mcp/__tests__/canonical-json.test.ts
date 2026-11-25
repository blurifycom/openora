import { describe, it } from 'vitest';

describe('sha256Hex', () => {
  it.todo('equal values with different key order produce the same hash');
  it.todo('keys are sorted at every depth');
  it.todo('undefined members are dropped from objects and become null in arrays');
  it.todo('a bigint hashes as its decimal string');
  it.todo('a reference cycle hashes as the circular marker without throwing');
  it.todo('values nested deeper than 64 levels hash as the too-deep marker');
  it.todo('different values produce different hashes');
  it.todo('a top-level undefined hashes like null');
});

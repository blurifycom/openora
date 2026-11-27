import { describe, expect, it } from 'vitest';
import { assertOwnership } from '../ownership.js';

const OWNER = '0b6f4a52-3c1e-4f7a-9d2b-5e8c1a7f3d90';
const denied = new Error('not yours');

describe('assertOwnership', () => {
  it('passes when the record belongs to the caller', () => {
    expect(() => assertOwnership(OWNER, OWNER, denied)).not.toThrow();
  });

  it.each([
    ['another user', '7c2d9e14-8a3b-4c6f-b1e0-2f5a9d8c4b71'],
    ['the same id in upper case', OWNER.toUpperCase()],
    ['the id with trailing whitespace', `${OWNER} `],
    ['an empty id', ''],
  ])('throws the given error for %s', (_name, recordUserId) => {
    expect(() => assertOwnership(recordUserId, OWNER, denied)).toThrow(denied);
  });

  it('throws when the caller id is empty and the record has an owner', () => {
    expect(() => assertOwnership(OWNER, '', denied)).toThrow(denied);
  });
});

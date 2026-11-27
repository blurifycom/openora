import { describe, expect, it } from 'vitest';
import { isUniqueConstraintViolation, pgErrorCode } from '../social.service.js';

describe('pgErrorCode', () => {
  it('reads the code of the error itself', () => {
    expect(pgErrorCode({ code: '23505' })).toBe('23505');
  });

  it('reads the code of a wrapped cause', () => {
    expect(
      pgErrorCode(Object.assign(new Error('Failed query'), { cause: { code: '23505' } })),
    ).toBe('23505');
  });

  it('reads the code through several wrappers', () => {
    expect(pgErrorCode({ cause: { cause: { cause: { code: '40001' } } } })).toBe('40001');
  });

  it('prefers the outer string code over the cause', () => {
    expect(pgErrorCode({ code: 'ECONNRESET', cause: { code: '23505' } })).toBe('ECONNRESET');
  });

  it('skips a non-string code and reads the cause', () => {
    expect(pgErrorCode({ code: 23505, cause: { code: '23503' } })).toBe('23503');
  });

  it.each([
    null,
    undefined,
    'string',
    23505,
    true,
    {},
    { cause: null },
    { cause: 'x' },
    { code: 5 },
    [],
  ])('finds no code in %j', (value) => {
    expect(pgErrorCode(value)).toBeUndefined();
  });
});

describe('isUniqueConstraintViolation', () => {
  it.each([
    [{ code: '23505' }, true],
    [{ cause: { code: '23505' } }, true],
    [{ code: '23503' }, false],
    [{ code: '23505 ' }, false],
    [{ code: 23505 }, false],
    [{ cause: { code: '23503' } }, false],
    [new Error('duplicate key value violates unique constraint'), false],
    [null, false],
    [undefined, false],
    ['23505', false],
  ])('%j is a unique violation: %s', (value, expected) => {
    expect(isUniqueConstraintViolation(value)).toBe(expected);
  });

  it('does not take an outer unrelated string code for a unique violation even when the cause is one', () => {
    expect(isUniqueConstraintViolation({ code: 'ECONNRESET', cause: { code: '23505' } })).toBe(
      false,
    );
  });
});

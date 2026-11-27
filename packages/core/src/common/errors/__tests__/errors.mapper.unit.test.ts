import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.base.js';
import { ConflictError, ValidationError } from '../errors.classes.js';
import { mapDbError } from '../errors.mapper.js';

const pgError = (code: string) => {
  const error = new DatabaseError('database said no', 1, 'error');
  error.code = code;
  return error;
};

const thrown = (err: unknown): unknown => {
  try {
    mapDbError(err);
  } catch (caught) {
    return caught;
  }
  return undefined;
};

describe('mapDbError', () => {
  it.each([
    ['23505', ConflictError, 'Resource already exists'],
    ['23503', ValidationError, 'Referenced resource does not exist'],
    ['23502', ValidationError, 'Missing required field'],
    ['23514', ValidationError, 'Invalid value'],
  ])('maps pg code %s to %O', (code, errorClass, message) => {
    const mapped = thrown(pgError(code));
    expect(mapped).toBeInstanceOf(errorClass);
    expect(mapped).toMatchObject({ message });
  });

  it('maps any other pg code to a DB_ERROR that keeps the code but not the pg message', () => {
    const mapped = thrown(pgError('40001'));
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped).toMatchObject({
      message: 'Database error',
      code: 'DB_ERROR',
      meta: { code: '40001' },
    });
  });

  it.each([
    ['a plain error', new Error('boom')],
    ['a plain object with a pg code', { code: '23505' }],
    ['a string', 'boom'],
  ])('rethrows %s unchanged', (_name, err) => {
    expect(thrown(err)).toBe(err);
  });

  it('maps a unique violation that drizzle wrapped in a DrizzleQueryError to a conflict', () => {
    const wrapped = new DrizzleQueryError('insert into tag ...', [], pgError('23505'));
    expect(thrown(wrapped)).toBeInstanceOf(ConflictError);
  });
});

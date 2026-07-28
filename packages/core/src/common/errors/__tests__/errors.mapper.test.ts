import { describe, it, expect } from 'vitest';
import { DatabaseError } from 'pg';
import { mapDbError } from '../errors.mapper.js';
import { ConflictError, ValidationError } from '../errors.classes.js';
import { AppError } from '../errors.base.js';

const pgError = (code: string) => {
  const err = new DatabaseError('driver text', 0, 'error');
  err.code = code;
  return err;
};

describe('mapDbError', () => {
  it('maps a unique violation to a conflict', () => {
    expect(() => mapDbError(pgError('23505'))).toThrow(ConflictError);
  });

  it.each([
    ['23503', 'a foreign key violation'],
    ['23502', 'a not-null violation'],
    ['23514', 'a check constraint violation'],
  ])('maps %s (%s) to a validation error', (code) => {
    expect(() => mapDbError(pgError(code))).toThrow(ValidationError);
  });

  it('keeps the driver code as metadata on an unrecognised database error', () => {
    try {
      mapDbError(pgError('40001'));
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).meta).toEqual({ code: '40001' });
      return;
    }
    throw new Error('expected mapDbError to throw');
  });

  it('does not swallow a non-database error', () => {
    const original = new Error('boom');
    expect(() => mapDbError(original)).toThrow(original);
  });

  it('rethrows a domain error untouched so a service guard is not reclassified', () => {
    const domain = new ConflictError('tag key already in use');
    try {
      mapDbError(domain);
    } catch (err) {
      expect(err).toBe(domain);
      return;
    }
    throw new Error('expected mapDbError to throw');
  });

  it('passes a non-Error rejection value through unchanged', () => {
    try {
      mapDbError('connection terminated');
    } catch (err) {
      expect(err).toBe('connection terminated');
      return;
    }
    throw new Error('expected mapDbError to throw');
  });
});

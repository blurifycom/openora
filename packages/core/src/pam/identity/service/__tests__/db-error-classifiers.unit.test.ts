import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { isPhoneNumberCollision } from '../phone-verification.service.js';
import { isUniqueViolation } from '../user-commands.service.js';

const dbError = (code: string, constraint?: string) => {
  const error = new DatabaseError('duplicate key', 0, 'error');
  error.code = code;
  error.constraint = constraint;
  return error;
};

const wrapped = (cause: unknown) => new Error('Failed query', { cause });

describe('isUniqueViolation', () => {
  const CONSTRAINT = 'user_username_unique';

  it('accepts the driver error itself', () => {
    expect(isUniqueViolation(dbError('23505', CONSTRAINT), CONSTRAINT)).toBe(true);
  });

  it('accepts the driver error under .cause', () => {
    expect(isUniqueViolation(wrapped(dbError('23505', CONSTRAINT)), CONSTRAINT)).toBe(true);
  });

  it('rejects another constraint', () => {
    expect(isUniqueViolation(dbError('23505', 'user_email_unique'), CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(wrapped(dbError('23505', 'user_email_unique')), CONSTRAINT)).toBe(
      false,
    );
  });

  it('rejects a different error code on the same constraint', () => {
    expect(isUniqueViolation(dbError('23503', CONSTRAINT), CONSTRAINT)).toBe(false);
  });

  it('rejects a violation without a constraint name', () => {
    expect(isUniqueViolation(dbError('23505'), CONSTRAINT)).toBe(false);
  });

  it('rejects a cause nested two levels deep', () => {
    expect(isUniqueViolation(wrapped(wrapped(dbError('23505', CONSTRAINT))), CONSTRAINT)).toBe(
      false,
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'boom'],
    ['a number', 23505],
    ['a plain object shaped like the error', { code: '23505', constraint: 'user_username_unique' }],
    ['an error without a cause', new Error('x')],
    ['an error with a plain object cause', wrapped({ code: '23505', constraint: CONSTRAINT })],
  ])('rejects %s', (_name, error) => {
    expect(isUniqueViolation(error, CONSTRAINT)).toBe(false);
  });
});

describe('isPhoneNumberCollision', () => {
  it('accepts the phone constraint, direct or wrapped', () => {
    expect(isPhoneNumberCollision(dbError('23505', 'user_phoneNumber_unique'))).toBe(true);
    expect(isPhoneNumberCollision(wrapped(dbError('23505', 'user_phoneNumber_unique')))).toBe(true);
  });

  it.each([
    ['another constraint', dbError('23505', 'user_email_unique')],
    ['another code', dbError('40001', 'user_phoneNumber_unique')],
    ['a wrapped other constraint', wrapped(dbError('23505', 'user_username_unique'))],
    ['null', null],
    ['undefined', undefined],
    ['a plain error', new Error('x')],
  ])('rejects %s', (_name, error) => {
    expect(isPhoneNumberCollision(error)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  Disable2faInputSchema,
  RegenerateBackupCodesInputSchema,
  normalizeBackupCode,
} from '../identity.js';

describe('normalizeBackupCode', () => {
  it('puts the hyphen back into a code typed without it', () => {
    expect(normalizeBackupCode('aBcDe12345')).toBe('aBcDe-12345');
  });

  it('leaves a hyphenated code as it is, minus surrounding whitespace', () => {
    expect(normalizeBackupCode(' aBcDe-12345 ')).toBe('aBcDe-12345');
  });

  it('does not reshape anything that is not ten letters and digits', () => {
    expect(normalizeBackupCode('123456')).toBe('123456');
  });
});

describe('Disable2faInputSchema', () => {
  const password = 'password1234';

  it('defaults to a live six-digit code', () => {
    expect(Disable2faInputSchema.parse({ password, code: '123456' })).toEqual({
      password,
      code: '123456',
      method: 'live',
    });
  });

  // Without the method the code would be checked as a TOTP and spend a lockout strike.
  it('refuses a backup code sent without its method', () => {
    expect(Disable2faInputSchema.safeParse({ password, code: 'aBcDe-12345' }).success).toBe(false);
  });

  it('refuses a six-digit code sent as a backup code', () => {
    expect(
      Disable2faInputSchema.safeParse({ password, code: '123456', method: 'backup_code' }).success,
    ).toBe(false);
  });

  it('normalises a backup code typed without its hyphen', () => {
    expect(
      Disable2faInputSchema.parse({ password, code: 'aBcDe12345', method: 'backup_code' }),
    ).toMatchObject({ code: 'aBcDe-12345', method: 'backup_code' });
  });
});

describe('RegenerateBackupCodesInputSchema', () => {
  it('takes only a live code', () => {
    expect(
      RegenerateBackupCodesInputSchema.safeParse({
        password: 'password1234',
        code: 'aBcDe-12345',
        method: 'backup_code',
      }).success,
    ).toBe(false);
  });
});

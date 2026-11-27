import fc from 'fast-check';
import { ORPCError } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import {
  OtpCancelledError,
  OtpCooldownError,
  OtpInvalidError,
  phoneOtpShadowKey,
} from '../phone-login.service.js';
import {
  phoneVerificationCooldownError,
  phoneVerificationInvalidError,
} from '../phone-verification.service.js';
import { generatedAdminUsername } from '../user-commands.service.js';

describe('generatedAdminUsername', () => {
  it('is admin_ followed by 12 lowercase hex characters', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatedAdminUsername()).toMatch(/^admin_[0-9a-f]{12}$/);
    }
  });

  it('does not repeat across a thousand calls', () => {
    const names = new Set(Array.from({ length: 1000 }, generatedAdminUsername));
    expect(names.size).toBe(1000);
  });
});

describe('phoneOtpShadowKey', () => {
  it('prefixes the phone', () => {
    expect(phoneOtpShadowKey('+48123456789')).toBe('phone-otp-shadow:+48123456789');
  });

  it('is injective over phones', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(phoneOtpShadowKey(a) === phoneOtpShadowKey(b)).toBe(a === b);
      }),
    );
  });
});

describe('phone login errors', () => {
  it('cooldown is TOO_MANY_REQUESTS carrying retryAfterMs', () => {
    const error = OtpCooldownError(42_000);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe('TOO_MANY_REQUESTS');
    expect(error.data).toEqual({ retryAfterMs: 42_000 });
  });

  it.each([
    ['expired', 'The code has expired.'],
    ['wrong_code', 'The code is invalid.'],
  ] as const)('invalid %s says %j and carries the attempts left', (reason, message) => {
    const error = OtpInvalidError(3, reason);
    expect(error.code).toBe('UNPROCESSABLE_CONTENT');
    expect(error.message).toBe(message);
    expect(error.data).toEqual({ attemptsRemaining: 3, reason });
  });

  it('cancelled is FORBIDDEN with the otp_cancelled reason', () => {
    const error = OtpCancelledError();
    expect(error.code).toBe('FORBIDDEN');
    expect(error.data).toEqual({ reason: 'otp_cancelled' });
  });

  it('never leaks a phone number or code in any message', () => {
    const messages = [
      OtpCooldownError(1).message,
      OtpInvalidError(0, 'wrong_code').message,
      OtpCancelledError().message,
    ];
    expect(messages.join(' ')).not.toMatch(/\d{4,}/);
  });
});

describe('phone verification errors', () => {
  it('cooldown matches the login cooldown shape', () => {
    const error = phoneVerificationCooldownError(1500);
    expect(error.code).toBe('TOO_MANY_REQUESTS');
    expect(error.data).toEqual({ retryAfterMs: 1500 });
    expect(error.message).toBe(OtpCooldownError(1500).message);
  });

  it('invalid does not say whether the code expired or was wrong', () => {
    const error = phoneVerificationInvalidError();
    expect(error.code).toBe('UNPROCESSABLE_CONTENT');
    expect(error.message).toBe('The code is invalid or expired.');
    expect(error.data).toBeUndefined();
  });
});

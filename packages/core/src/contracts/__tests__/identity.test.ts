import { describe, it, expect } from 'vitest';
import {
  ChangePasswordInputSchema,
  LoginInputSchema,
  RegisterInputSchema,
  ResetPasswordInputSchema,
} from '../schemas/identity.js';

const OVER_LENGTH = 'a'.repeat(129);

const registerInput = (password: string) => ({
  email: 'player@example.com',
  password,
  username: 'new_player',
  acceptedTerms: true as const,
  acceptedAge: true as const,
});

describe('password rules', () => {
  it('holds sign-up to the same bounds as the password reset flow', () => {
    expect(RegisterInputSchema.safeParse(registerInput('short')).success).toBe(false);
    expect(RegisterInputSchema.safeParse(registerInput('password123')).success).toBe(false);
    expect(RegisterInputSchema.safeParse(registerInput('password1234')).success).toBe(true);
  });

  // better-auth caps at 128 itself, but only after the fact: on sign-up that surfaces as
  // a generic "Registration is unavailable", and on reset it burns the one-time code
  // first. Both must be rejected at the contract instead.
  it.each([
    ['register', () => RegisterInputSchema.safeParse(registerInput(OVER_LENGTH))],
    [
      'reset',
      () =>
        ResetPasswordInputSchema.safeParse({
          email: 'player@example.com',
          otp: '123456',
          newPassword: OVER_LENGTH,
        }),
    ],
    [
      'change',
      () =>
        ChangePasswordInputSchema.safeParse({
          currentPassword: 'password1234',
          newPassword: OVER_LENGTH,
        }),
    ],
  ])('rejects a password over 128 characters on %s', (_name, parse) => {
    expect(parse().success).toBe(false);
  });

  // Sign-in is deliberately left uncapped: no longer password was ever storable, so a
  // bound there could only narrow an existing contract for nothing.
  it('does not cap the password on sign-in', () => {
    const result = LoginInputSchema.safeParse({
      email: 'player@example.com',
      password: OVER_LENGTH,
    });

    expect(result.success).toBe(true);
  });
});

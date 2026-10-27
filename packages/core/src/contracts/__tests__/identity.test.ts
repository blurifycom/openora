import { describe, it, expect } from 'vitest';
import {
  ACQUISITION_MAX_PARAMS,
  ChangePasswordInputSchema,
  LoginInputSchema,
  PasswordSchema,
  RegisterInputSchema,
  RegistrationAcquisitionSchema,
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
  it('enforces the 12-character platform password policy on PasswordSchema', () => {
    expect(PasswordSchema.safeParse('a'.repeat(11)).success).toBe(false);
    expect(PasswordSchema.safeParse('a'.repeat(12)).success).toBe(true);
  });

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

describe('registration acquisition', () => {
  const paramsOf = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, 'v']));

  it('accepts a bounded set of named parameters with optional landing context', () => {
    expect(
      RegistrationAcquisitionSchema.safeParse({
        params: { aff_id: 'a_1b_2', 'utm.source': 'site-1' },
        firstSeenAt: '2026-10-01T12:00:00.000Z',
        landingHost: 'casino.example:3000',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['no parameters', { params: {} }],
    ['only a key outside the allowed characters', { params: { 'bad key': 'v' } }],
    ['only an over-long key', { params: { ['k'.repeat(65)]: 'v' } }],
    ['only an empty value', { params: { aff_id: '' } }],
    ['only an over-long value', { params: { aff_id: 'v'.repeat(257) } }],
    ['only a value with a control character', { params: { aff_id: 'a\u0000b' } }],
    ['only a value that is not well-formed Unicode', { params: { aff_id: 'a\ud800b' } }],
    ['only a value that is not a string', { params: { aff_id: 7 } }],
  ])('rejects %s', (_case, input) => {
    expect(RegistrationAcquisitionSchema.safeParse(input).success).toBe(false);
  });

  it('drops an invalid parameter and keeps the rest', () => {
    expect(
      RegistrationAcquisitionSchema.parse({
        params: { aff_id: 'a_1', 'bad key': 'v', utm_source: 'a\u0000b', utm_medium: 'email' },
      }).params,
    ).toEqual({ aff_id: 'a_1', utm_medium: 'email' });
  });

  it('keeps the first parameters up to the cap', () => {
    expect(
      Object.keys(
        RegistrationAcquisitionSchema.parse({ params: paramsOf(ACQUISITION_MAX_PARAMS + 3) })
          .params,
      ),
    ).toEqual(Object.keys(paramsOf(ACQUISITION_MAX_PARAMS)));
  });

  it('drops an invalid landing host or first-seen time and keeps the parameters', () => {
    expect(
      RegistrationAcquisitionSchema.parse({
        params: { aff_id: 'v' },
        firstSeenAt: 'yesterday',
        landingHost: '[::1]:3000',
      }),
    ).toEqual({ params: { aff_id: 'v' } });
  });

  it('accepts a first-seen time with a UTC offset', () => {
    expect(
      RegistrationAcquisitionSchema.parse({
        params: { aff_id: 'v' },
        firstSeenAt: '2026-10-01T14:00:00+02:00',
      }).firstSeenAt,
    ).toBe('2026-10-01T14:00:00+02:00');
  });

  it('accepts a value at the maximum length', () => {
    expect(
      RegistrationAcquisitionSchema.safeParse({ params: { aff_id: 'v'.repeat(256) } }).success,
    ).toBe(true);
  });

  it('keeps acquisition optional on sign-up', () => {
    expect(RegisterInputSchema.safeParse(registerInput('password1234')).success).toBe(true);
  });

  it('drops an acquisition with no valid parameter instead of refusing the sign-up', () => {
    const result = RegisterInputSchema.safeParse({
      ...registerInput('password1234'),
      acquisition: { params: { 'bad key': 'v' } },
    });

    expect(result.success).toBe(true);
    expect(result.data?.acquisition).toBeUndefined();
  });
});

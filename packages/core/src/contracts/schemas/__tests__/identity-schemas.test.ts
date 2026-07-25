import { describe, it, expect } from 'vitest';
import { LoginInputSchema, ResetPasswordInputSchema, UserSchema } from '../identity.js';

describe('identity schemas', () => {
  it('LoginInputSchema rejects a password under the minimum length', () => {
    expect(LoginInputSchema.safeParse({ email: 'a@b.dev', password: 'short' }).success).toBe(false);
  });

  it("ResetPasswordInputSchema rejects a password over better-auth's 128-char max", () => {
    const base = { email: 'a@b.dev', otp: '123456' };
    expect(
      ResetPasswordInputSchema.safeParse({ ...base, newPassword: 'a'.repeat(128) }).success,
    ).toBe(true);
    expect(
      ResetPasswordInputSchema.safeParse({ ...base, newPassword: 'a'.repeat(129) }).success,
    ).toBe(false);
  });

  it('UserSchema allows an absent or null image', () => {
    const base = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'a@b.dev',
      name: 'Alice',
      emailVerified: true,
      theme: 'system',
      language: 'en',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(UserSchema.safeParse(base).success).toBe(true);
    expect(UserSchema.safeParse({ ...base, image: null }).success).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { LoginInputSchema, RegisterInputSchema, UserSchema } from '../identity.js';

describe('identity schemas', () => {
  it('LoginInputSchema accepts a valid credential pair', () => {
    const parsed = LoginInputSchema.parse({ email: 'a@b.dev', password: 'password123' });
    expect(parsed.email).toBe('a@b.dev');
  });

  it('LoginInputSchema rejects a bad email and a short password', () => {
    expect(LoginInputSchema.safeParse({ email: 'nope', password: 'password123' }).success).toBe(
      false,
    );
    expect(LoginInputSchema.safeParse({ email: 'a@b.dev', password: 'short' }).success).toBe(false);
  });

  it('RegisterInputSchema requires a non-empty name', () => {
    expect(
      RegisterInputSchema.safeParse({ email: 'a@b.dev', password: 'password123', name: '' })
        .success,
    ).toBe(false);
  });

  it('UserSchema allows an absent or null image', () => {
    const base = {
      id: 'u1',
      email: 'a@b.dev',
      name: 'Alice',
      emailVerified: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(UserSchema.safeParse(base).success).toBe(true);
    expect(UserSchema.safeParse({ ...base, image: null }).success).toBe(true);
  });
});

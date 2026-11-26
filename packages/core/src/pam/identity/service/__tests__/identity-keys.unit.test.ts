import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loginShadowKey, makeLoginRateLimitKey, toUser } from '../identity.service.js';

type In = Parameters<typeof toUser>[0];

const user = (over: Partial<In> = {}): In => ({
  id: 'u1',
  email: 'a@x.com',
  name: 'A',
  username: 'a',
  emailVerified: true,
  twoFactorEnabled: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});

describe('makeLoginRateLimitKey', () => {
  it('lowercases the email so case tricks share one bucket', () => {
    expect(makeLoginRateLimitKey('A@X.com')).toBe('login:a@x.com');
    expect(makeLoginRateLimitKey('A@X.com')).toBe(makeLoginRateLimitKey('a@x.COM'));
  });

  it('is case-insensitive for any email', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        expect(makeLoginRateLimitKey(email.toUpperCase())).toBe(makeLoginRateLimitKey(email));
      }),
    );
  });
});

describe('loginShadowKey', () => {
  it('is namespaced per email', () => {
    expect(loginShadowKey('a@x.com')).toBe('login-shadow:a@x.com');
    expect(loginShadowKey('a@x.com')).not.toBe(loginShadowKey('b@x.com'));
  });

  it('never collides with the rate limit key space', () => {
    expect(loginShadowKey('a@x.com')).not.toBe(makeLoginRateLimitKey('a@x.com'));
  });
});

describe('toUser', () => {
  it('defaults theme to system and language to en', () => {
    const out = toUser(user());
    expect(out.theme).toBe('system');
    expect(out.language).toBe('en');
  });

  it('reads a missing second-factor flag as off', () => {
    expect(toUser(user({ twoFactorEnabled: undefined })).twoFactorEnabled).toBe(false);
  });

  it('defaults null theme and language too', () => {
    const out = toUser(user({ theme: null, language: null }));
    expect(out.theme).toBe('system');
    expect(out.language).toBe('en');
  });

  it('keeps explicit values', () => {
    const out = toUser(user({ theme: 'dark', language: 'de', twoFactorEnabled: true }));
    expect(out.theme).toBe('dark');
    expect(out.language).toBe('de');
    expect(out.twoFactorEnabled).toBe(true);
  });

  it('serialises dates to ISO and passes strings through', () => {
    const out = toUser(user());
    expect(out.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(out.updatedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('omits the image key when undefined', () => {
    expect('image' in toUser(user())).toBe(false);
  });

  it.each([['https://x/y.png'], [null]])('keeps image %s when defined', (image) => {
    expect(toUser(user({ image }))).toHaveProperty('image', image);
  });
});

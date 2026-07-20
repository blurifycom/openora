import { describe, it, expect } from 'vitest';
import { signSessionCookie } from '../sign-session-cookie.js';

const SESSION_COOKIE = {
  name: 'better-auth.session_token',
  attributes: { httpOnly: true, secure: false, sameSite: 'lax' as const, path: '/' },
};

describe('signSessionCookie', () => {
  it('produces a signature matching a known-good vector', () => {
    // Golden vector, independently verified against the real better-call
    // `verifySignature`/`getCryptoKey` (the exact functions `auth.api.getSession` calls
    // through better-auth) - not just recomputed with this same module's own algorithm.
    // A change to the HMAC key, digest, or encoding would show up here as a diff against
    // a value this test doesn't derive.
    const cookie = signSessionCookie({
      token: 'fixed-token-for-golden-vector',
      sessionCookie: SESSION_COOKIE,
      secret: 'unit-test-secret-do-not-use-in-prod',
      maxAgeSeconds: 3600,
    });

    expect(cookie).toContain(
      'better-auth.session_token=fixed-token-for-golden-vector.HUa0peblWWtfebbtuTmir7Km5kqZbRR2ZVIMnEP8BDQ%3D',
    );
  });

  it('carries the cookie attributes and the given max-age', () => {
    const cookie = signSessionCookie({
      token: 't',
      sessionCookie: SESSION_COOKIE,
      secret: 's',
      maxAgeSeconds: 86_400,
    });

    expect(cookie).toContain('Max-Age=86400');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('differs for different secrets, so a signature cannot be replayed across environments', () => {
    const a = signSessionCookie({
      token: 'same-token',
      sessionCookie: SESSION_COOKIE,
      secret: 'secret-a',
      maxAgeSeconds: 60,
    });
    const b = signSessionCookie({
      token: 'same-token',
      sessionCookie: SESSION_COOKIE,
      secret: 'secret-b',
      maxAgeSeconds: 60,
    });
    expect(a).not.toBe(b);
  });

  it('omits Max-Age when no ttl is given, producing a real browser session cookie', () => {
    // better-auth's own `authCookies.sessionToken.attributes` bakes in a default
    // `maxAge` (its static session config, eg 7 days) - this fixture reproduces that so
    // the test actually exercises stripping an INHERITED value, not just never setting
    // one. Regression guard for a bug where the inherited default leaked through on a
    // "don't remember me" login, making every phone login persistent regardless of the
    // player's choice.
    const cookieWithInheritedDefault = {
      name: 'better-auth.session_token',
      attributes: { ...SESSION_COOKIE.attributes, maxAge: 7 * 24 * 60 * 60 },
    };

    const cookie = signSessionCookie({
      token: 't',
      sessionCookie: cookieWithInheritedDefault,
      secret: 's',
      maxAgeSeconds: undefined,
    });

    expect(cookie).not.toContain('Max-Age');
  });
});

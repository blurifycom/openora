import { createHmac } from 'node:crypto';
import { serialize } from 'hono/utils/cookie';

export type SessionCookieConfig = {
  name: string;
  attributes: {
    domain?: string;
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    secure?: boolean;
    sameSite?: 'strict' | 'lax' | 'none' | 'Strict' | 'Lax' | 'None';
  };
};

/**
 * Builds a `Set-Cookie` header for a hand-minted session token, byte-compatible with
 * better-auth's own signed session cookie so `auth.api.getSession` can read it back.
 *
 * Only for a caller that mints a `session` row directly instead of going through
 * better-auth's own sign-in endpoints (which sign their own cookie internally and
 * expose it via `Response.headers.getSetCookie()` - see `forwardCookies` in
 * identity.service.ts). Reproduces better-auth's cookie value format
 * (`${token}.${base64(HMAC-SHA256(secret, token))}`, verified in
 * better-call's `getSignedCookie`) using `node:crypto` rather than importing
 * `better-call` directly, which is a transitive dependency of better-auth, not a
 * package this repo depends on.
 *
 * `maxAgeSeconds` is passed in rather than taken from `sessionCookie.attributes.maxAge`
 * (better-auth's own static config default) so the cookie tracks the real expiry of the
 * session row it was minted for. Pass `undefined` for a "don't remember me" login: the
 * `maxAge` attribute is dropped entirely (not defaulted to better-auth's own 7-day
 * config value), producing a true browser session cookie the browser discards on close -
 * matching how better-auth's own email/password sign-in behaves for the same case. The
 * underlying `session` row still expires server-side on its own schedule regardless;
 * this only controls whether the *cookie* survives a browser restart.
 */
export function signSessionCookie({
  token,
  sessionCookie,
  secret,
  maxAgeSeconds,
}: {
  token: string;
  sessionCookie: SessionCookieConfig;
  secret: string;
  maxAgeSeconds?: number;
}): string {
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  const signedValue = `${token}.${signature}`;
  const attributes = { ...sessionCookie.attributes };
  if (maxAgeSeconds === undefined) {
    delete attributes.maxAge;
  } else {
    attributes.maxAge = maxAgeSeconds;
  }
  return serialize(sessionCookie.name, signedValue, attributes);
}

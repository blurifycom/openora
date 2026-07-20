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

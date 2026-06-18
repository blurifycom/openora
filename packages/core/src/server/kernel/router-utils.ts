import { ORPCError } from '@orpc/server';

type RequestLike = { headers: Record<string, string | string[] | undefined> };

// The VERIFIED caller identity for the request. Populated ONCE per request by the
// createApp middleware after it verifies the better-auth session cookie (via the
// shared SessionResolver in @oss/core/server). It is NEVER taken from a
// client-supplied header - a forged `x-user-id` cannot reach this field. Absent
// when the request has no valid session (public/auth routes); handlers that
// require a caller call getUserId, which 401s when it is absent.
export type AuthContext = {
  userId: string;
};

// The context every oRPC handler receives. The Hono adapter builds `request`
// per request (see @oss/core/server createApp). `auth` carries the verified
// identity (above). `resHeaders` is injected by oRPC's ResponseHeadersPlugin -
// handlers append Set-Cookie to it (eg auth login).
export type OssContext = {
  request: RequestLike;
  auth?: AuthContext;
  resHeaders?: Headers;
};

function resolveAuth(context: unknown): AuthContext {
  if (
    typeof context !== 'object' ||
    context === null ||
    !('request' in context) ||
    typeof (context as Record<string, unknown>).request !== 'object'
  ) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Missing request context' });
  }

  const auth = (context as { auth?: AuthContext }).auth;
  if (!auth?.userId) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Authentication required' });
  }

  return auth;
}

// The authenticated caller's user id, taken from the VERIFIED session resolved by
// the createApp middleware. Throws UNAUTHORIZED when there is no valid session.
export function getUserId(context: unknown): string {
  return resolveAuth(context).userId;
}

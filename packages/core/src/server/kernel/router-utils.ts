import { ORPCError } from '@orpc/server';

type RequestLike = { headers: Record<string, string | string[] | undefined> };

// NEVER sourced from a client-supplied header - a forged `x-user-id` cannot reach this field.
export type AuthContext = {
  userId: string;
};

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

export function getUserId(context: unknown): string {
  return resolveAuth(context).userId;
}

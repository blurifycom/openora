import { ORPCError } from '@orpc/server';
import type { ClientMeta } from '@openora/core/contracts';

// Raw Node `IncomingHttpHeaders`-shaped map, as the runtime hands it to services.
export type NodeHeaders = Record<string, string | string[] | undefined>;

type RequestLike = { headers: NodeHeaders };

// NEVER sourced from a client-supplied header - a forged `x-user-id` cannot reach this field.
export type AuthContext = {
  userId: string;
};

export type OssContext = {
  request: RequestLike;
  auth?: AuthContext;
  resHeaders?: Headers;
  // The verbatim request body, captured by the runtime for signature verification
  // (eg aggregator webhooks). Present only for signed, bounded-size bodies.
  rawBody?: string;
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

export function extractClientMeta(headers: NodeHeaders): ClientMeta {
  const fwd = headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  const real = headers['x-real-ip'];
  const ip = first?.split(',')[0]?.trim() || (Array.isArray(real) ? real[0] : real) || null;
  const ua = headers['user-agent'];
  return { ip: ip ?? null, userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? null };
}

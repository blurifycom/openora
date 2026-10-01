import { ORPCError } from '@orpc/server';
import type { ClientMeta } from '@openora/core/contracts';
import { AuthGuardReasonSchema } from '@openora/core/contracts';

// Raw Node `IncomingHttpHeaders`-shaped map, as the runtime hands it to services.
export type NodeHeaders = Record<string, string | string[] | undefined>;

type RequestLike = { headers: NodeHeaders };

// NEVER sourced from a client-supplied header - a forged `x-user-id` cannot reach this field.
export type AuthContext = {
  userId: string;
  // Id of the better-auth session row backing this request. Lets a handler tell the
  // caller's own session apart from their other devices (eg "In Use" vs "Revoke").
  sessionId?: string | undefined;
  // Set by the request middleware while the account owes a second-factor enrolment
  // (TWO_FACTOR_SETUP_POLICY); every route that reads the caller through getUserId is
  // refused until it is done.
  twoFactorSetupRequired?: boolean | undefined;
};

export type OssContext = {
  request: RequestLike;
  clientMeta: ClientMeta;
  auth?: AuthContext;
  resHeaders?: Headers;
  // The verbatim request body, captured by the runtime for signature verification
  // (eg aggregator webhooks). Present only for signed, bounded-size bodies.
  rawBody?: string;
};

export type ResolveAuthOptions = {
  // For the few routes an account must still reach while it owes a second-factor
  // enrolment: the session stream, its own sessions, and the phone verification an SMS
  // factor needs.
  allowPendingTwoFactorSetup?: boolean;
};

function resolveAuth(context: unknown, opts?: ResolveAuthOptions): AuthContext {
  if (
    typeof context !== 'object' ||
    context === null ||
    !('request' in context) ||
    typeof (context as Record<string, unknown>).request !== 'object'
  ) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'Missing request context',
      data: { reason: AuthGuardReasonSchema.enum.missing_request_context },
    });
  }

  const auth = (context as { auth?: AuthContext }).auth;
  if (!auth?.userId) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'Authentication required',
      data: { reason: AuthGuardReasonSchema.enum.authentication_required },
    });
  }

  if (auth.twoFactorSetupRequired && !opts?.allowPendingTwoFactorSetup) {
    throw new ORPCError('FORBIDDEN', {
      message: 'Set up two-factor authentication to continue',
      data: { reason: AuthGuardReasonSchema.enum.two_factor_setup_required },
    });
  }

  return auth;
}

export function getUserId(context: unknown, opts?: ResolveAuthOptions): string {
  return resolveAuth(context, opts).userId;
}

export function getSessionId(context: unknown, opts?: ResolveAuthOptions): string | undefined {
  return resolveAuth(context, opts).sessionId;
}

// Extracts IP only from headers; does not trust X-Forwarded-For without a
// validated proxy boundary. Behind `createApp` those headers are already sanitized:
// X-Real-IP is the socket peer unless that peer is a configured trusted proxy (see
// runtime/client-address.ts). Geo/rate-limit checks use this - a spoofed
// X-Forwarded-For bypasses both. Use extractClientMeta({ headers, trustForwarded: true })
// only when Node receives requests exclusively through a trusted reverse proxy
// (Cloudflare, nginx, etc configured to strip and replace the header).
export function extractClientMeta(
  headers: NodeHeaders,
  opts?: { trustForwarded?: boolean },
): ClientMeta {
  let ip: string | null = null;
  if (opts?.trustForwarded) {
    const fwd = headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : fwd;
    ip = first?.split(',')[0]?.trim() || null;
  }
  if (!ip) {
    const real = headers['x-real-ip'];
    ip = (Array.isArray(real) ? real[0] : real) || null;
  }
  const ua = headers['user-agent'];
  return { ip: ip ?? null, userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? null };
}

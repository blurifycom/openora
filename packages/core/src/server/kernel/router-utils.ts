import { ORPCError, os } from '@orpc/server';
import * as z from 'zod';
import type { ClientMeta } from '@openora/core/contracts';
import { AuthGuardReasonSchema } from '@openora/core/contracts';

// Raw Node `IncomingHttpHeaders`-shaped map, as the runtime hands it to services.
export type NodeHeaders = Record<string, string | string[] | undefined>;

type RequestLike = { headers: NodeHeaders };

// NEVER sourced from a client-supplied header - a forged `x-user-id` cannot reach this field.
export const AuthContextSchema = z.object({
  userId: z.string(),
  // Id of the better-auth session row backing this request. Lets a handler tell the
  // caller's own session apart from their other devices (eg "In Use" vs "Revoke").
  sessionId: z.string().optional(),
  // Set by the request middleware while the account owes a second-factor enrolment
  // (TWO_FACTOR_SETUP_POLICY); every route that reads the caller through getUserId is
  // refused until it is done.
  twoFactorSetupRequired: z.boolean().optional(),
});
export type AuthContext = z.infer<typeof AuthContextSchema>;

export const SessionEndedReasonSchema = z.literal('idle_timeout');
export type SessionEndedReason = z.infer<typeof SessionEndedReasonSchema>;

export type OssContext = {
  request: RequestLike;
  clientMeta: ClientMeta;
  auth?: AuthContext;
  // Set by the runtime when the request carried a session that the idle policy just ended, so
  // the guard can tell the caller why it is signed out rather than leaving them to guess.
  sessionEndedReason?: SessionEndedReason;
  // Set by the runtime when the session could not be resolved because the service that owns
  // sessions was unreachable. A route that needs a caller answers 503 instead of 401, so the
  // client retries rather than signing the player out; a public route is unaffected.
  sessionUnavailable?: true;
  resHeaders?: Headers;
  // The verbatim request body, captured by the runtime for signature verification
  // (eg aggregator webhooks). Present only for signed, bounded-size bodies.
  rawBody?: string;
};

// The context of a route a plugin adds with `ctx.routers.addInternal`. `internalCaller` is the
// `SERVICE_NAME` the request was signed as; a route allow-lists its callers on it. No `auth`,
// and the session headers are stripped from `request`: an internal route acts for a service,
// never for a player or an admin.
export type InternalContext = Omit<
  OssContext,
  'auth' | 'sessionEndedReason' | 'sessionUnavailable'
> & {
  auth?: never;
  internalCaller: string;
};

// The base procedure of every `addInternal` route. It refuses a request that carries no
// `internalCaller`, so a router mistakenly passed to `ctx.routers.add` (same factory type) is
// closed on the public surface instead of served unsigned.
export const internalProcedure = os.$context<InternalContext>().use(({ context, next }) => {
  if (typeof context.internalCaller !== 'string' || context.internalCaller === '') {
    throw new ORPCError('NOT_FOUND');
  }
  return next();
});

export type ResolveAuthOptions = {
  // For the few routes an account must still reach while it owes a second-factor
  // enrolment: the session streams, its own sessions, the phone verification an SMS factor
  // needs, and responsible-gambling self-protection.
  allowPendingTwoFactorSetup?: boolean;
};

/** A request whose session could not be looked up is retried by the client, not signed out. */
export function throwIfSessionUnavailable(context: unknown): void {
  if ((context as { sessionUnavailable?: true }).sessionUnavailable) {
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'The session service is unavailable',
    });
  }
}

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
    throwIfSessionUnavailable(context);
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

// Reads the client address from X-Real-IP only. Behind `createApp` that header is already
// decided: it is the socket peer unless that peer is a configured trusted proxy, in which case
// it is the client derived from X-Forwarded-For (see runtime/client-address.ts). Geo and
// rate-limit checks use this, so X-Forwarded-For is never read here - its leftmost entry is
// whatever the caller chose to send.
export function extractClientMeta(headers: NodeHeaders): ClientMeta {
  const real = headers['x-real-ip'];
  const ip = (Array.isArray(real) ? real[0] : real) || null;
  const ua = headers['user-agent'];
  return { ip, userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? null };
}

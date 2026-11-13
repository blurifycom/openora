import * as z from 'zod';
import {
  createToken,
  type PlayerActivityTracker,
  type SessionIdlePolicy,
  type Token,
  type TwoFactorSetupPolicy,
} from '@openora/core/contracts';
import { createLogger } from '../kernel/logger.js';
import {
  AuthContextSchema,
  SessionEndedReasonSchema,
  type AuthContext,
  type SessionEndedReason,
} from '../kernel/router-utils.js';
import type { SessionResolver } from './session-resolver.js';

/** What the request middleware learns from a request's credentials. */
export type SessionOutcome = {
  /** Absent: unauthenticated, for a missing, expired, idle or otherwise refused session. */
  auth?: AuthContext;
  /** Set when the idle policy ended the session on this very request. */
  sessionEndedReason?: SessionEndedReason;
  /**
   * Set when the session could not be looked up at all (the service that owns sessions timed out,
   * was unreachable or failed), as opposed to refused. The request carries no identity, and a
   * route that needs one answers 503 so the client retries instead of treating it as signed out.
   */
  unavailable?: true;
};

export type RequestSessionResolver = {
  resolve(headers: Headers): Promise<SessionOutcome>;
};

/** The chain run against this process's own database: the default behind every request. */
export const LOCAL_SESSION_RESOLVER: Token<RequestSessionResolver> =
  createToken('LOCAL_SESSION_RESOLVER');

/**
 * Bound by a service on a database of its own that has no session tables (chat): resolves each
 * request's credentials through the identity service instead, and replaces the local chain in
 * the request middleware and the admin guard.
 */
export const REMOTE_SESSION_RESOLVER: Token<RequestSessionResolver> =
  createToken('REMOTE_SESSION_RESOLVER');

export type SessionChainPorts = {
  sessions: Pick<SessionResolver, 'resolveSession'>;
  idlePolicy: SessionIdlePolicy | undefined;
  twoFactorPolicy: TwoFactorSetupPolicy | undefined;
  activity: PlayerActivityTracker | undefined;
};

/**
 * The one place a request's credentials become an identity: the session, the idle window, the
 * second-factor enrolment flag and the player's last-seen stamp. Runs in the request middleware
 * of a process that serves identity, and behind the identity service's internal session route,
 * so a service reading sessions remotely sees exactly what a local request would.
 */
export async function resolveSessionChain(
  ports: () => SessionChainPorts,
  headers: Headers,
): Promise<SessionOutcome> {
  const { sessions, idlePolicy, twoFactorPolicy, activity } = ports();
  // Never identify from a client-supplied `x-user-id` header (W1, ADR-0019).
  const resolved = await sessions.resolveSession(headers);
  if (!resolved) {
    // No valid session: auth stays undefined so getUserId 401s. Auth and public routes
    // still work.
    return {};
  }
  const { userId, sessionId } = resolved;

  // The player's "auto-logout when inactive" window. Checked before the session is
  // published, so an idled-out request is unauthenticated rather than served and 401ing
  // somewhere deeper. A DB error here takes the same path as an expired session rather than
  // throwing: it is a security check, so a transient failure must not serve the request
  // anyway, but it must also not turn into a 500 on every authenticated route the moment this
  // one query blips - the client should see "not signed in", the same honest answer an
  // actually-idle session gets, not "server broken".
  if (sessionId && idlePolicy) {
    let state: 'active' | 'expired' | 'idle';
    try {
      state = await idlePolicy.touch(userId, sessionId);
    } catch (err) {
      createLogger('session-idle').error({ err }, 'touch failed');
      state = 'expired';
    }
    if (state !== 'active') {
      return state === 'idle' ? { sessionEndedReason: 'idle_timeout' } : {};
    }
  }

  // Published as a flag rather than answered here: getUserId refuses it unless a route opts
  // in, and the identity router holds its own routes to an enrolment allowlist. A DB error
  // takes the unauthenticated path, as above.
  let twoFactorSetupRequired = false;
  if (twoFactorPolicy) {
    try {
      twoFactorSetupRequired = await twoFactorPolicy.isSetupRequired(userId);
    } catch (err) {
      createLogger('two-factor-setup').error({ err }, 'setup check failed');
      return {};
    }
  }

  if (activity) {
    // Awaited, not fire-and-forget. Modules and overlays read this stamp to decide whether a
    // player is online, so a request that refreshes presence must not be able to return
    // before the write lands: a second caller acting on the answer would otherwise read a
    // value the completed request had already superseded. The adapter narrows the update to
    // rows older than its throttle, so the statement is a no-op most of the time; the cost is
    // the round trip, on the same path that already awaits the idle policy above.
    //
    // A failure is still swallowed: presence is a hint, never authorisation, and losing the
    // stamp must not fail the request it rode in on.
    await activity
      .touchLastSeen(userId)
      .catch((err: unknown) =>
        createLogger('player-activity').error({ err }, 'touchLastSeen failed'),
      );
  }

  return { auth: twoFactorSetupRequired ? { ...resolved, twoFactorSetupRequired } : resolved };
}

/** The identity service's internal route behind {@link REMOTE_SESSION_RESOLVER}, under `/internal/v1`. */
export const SESSION_RESOLVER_ROUTE = '/identity/session';

// Generous for a cookie jar, small enough that the signed body stays bounded.
const CREDENTIAL_MAX_LENGTH = 16_384;

/**
 * Request and reply of {@link SESSION_RESOLVER_ROUTE}. The internal API strips the session
 * headers before a handler runs, so the caller forwards the credentials as body fields.
 */
export const SessionResolverWire = {
  input: z.object({
    cookie: z.string().max(CREDENTIAL_MAX_LENGTH).optional(),
    authorization: z.string().max(CREDENTIAL_MAX_LENGTH).optional(),
  }),
  output: z.object({
    auth: AuthContextSchema.nullable(),
    sessionEndedReason: SessionEndedReasonSchema.optional(),
  }),
} as const;

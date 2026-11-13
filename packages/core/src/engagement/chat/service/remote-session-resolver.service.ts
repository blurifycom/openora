import { createHash } from 'node:crypto';
import {
  createLogger,
  InternalApiError,
  SESSION_RESOLVER_ROUTE,
  SessionResolverWire,
  TtlCache,
  type AuthContext,
  type InternalClient,
  type RequestSessionResolver,
  type SessionOutcome,
} from '@openora/core/server';

// How long a session the identity service confirmed is served without asking again. It bounds
// how stale a sign-out that no event announces (the player's own logout) can be, and how
// stale the idle clock identity keeps (its shortest window is 15 minutes, its write throttle
// 60 seconds).
export const SESSION_CACHE_TTL_MS = 5_000;
const SESSION_CACHE_MAX_ENTRIES = 10_000;
// While identity is down every request fails; one line per this long says so, with the count.
export const FAILURE_LOG_INTERVAL_MS = 30_000;

// The cookies that carry a better-auth session: its token, and the `__Secure-` form it uses over
// https. The rest of a jar (analytics, consent, other apps on the domain) is neither forwarded
// nor part of the cache key, so it neither reaches identity nor splits one session's cache.
const SESSION_COOKIE_NAMES = new Set([
  'better-auth.session_token',
  '__Secure-better-auth.session_token',
]);

const sessionCookiesOf = (cookieHeader: string) =>
  cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => SESSION_COOKIE_NAMES.has(pair.slice(0, pair.indexOf('='))))
    .join('; ');

// Keyed by a digest, so a credential never sits in this process's memory as a map key, and a
// heap dump does not hand out session tokens. The separator keeps ("a", "b") and ("ab", "") apart.
const credentialKey = (cookie: string, authorization: string) =>
  createHash('sha256').update(`${cookie}\0${authorization}`).digest('hex');

// Identity could not be asked (timeout, no connection, 5xx), as opposed to answering no.
const isUnreachable = (err: unknown) => err instanceof InternalApiError && err.kind !== 'client';

const logger = createLogger('chat-remote-session');

/**
 * {@link RequestSessionResolver} over the identity service's internal API, for a service whose
 * database has no session tables. Identity runs the whole chain (session, idle window,
 * second-factor flag, last-seen stamp) on the forwarded session credentials. A confirmed session
 * is kept for {@link SESSION_CACHE_TTL_MS}; a refusal (no session, idle, expired) is never kept,
 * so a session that was just refused or has just been re-established is asked again on the next
 * request. A request with no session cookie and no `authorization` is unauthenticated without a
 * call. A call that fails resolves with no identity, never a stale or guessed one: `unavailable`
 * when identity could not be reached (the caller answers 503), plain unauthenticated when it
 * refused or answered something unreadable.
 */
export class RemoteSessionResolver implements RequestSessionResolver {
  private readonly cache: TtlCache<AuthContext, SessionOutcome>;
  // Bumped by every purge: an answer read before a purge must not be cached after it.
  private purges = 0;
  private failuresSinceLog = 0;
  private lastLoggedAt: number | undefined;

  constructor(
    private readonly client: InternalClient,
    private readonly now: () => number = Date.now,
  ) {
    this.cache = new TtlCache({
      ttlMs: SESSION_CACHE_TTL_MS,
      maxEntries: SESSION_CACHE_MAX_ENTRIES,
      now,
    });
  }

  async resolve(headers: Headers): Promise<SessionOutcome> {
    const cookie = sessionCookiesOf(headers.get('cookie') ?? '');
    const authorization = headers.get('authorization') ?? '';
    if (!cookie && !authorization) {
      return {};
    }
    const key = credentialKey(cookie, authorization);
    const cached = this.cache.get(key);
    if (cached) {
      return { auth: cached };
    }
    const joined = this.cache.pending(key);
    if (joined) {
      return joined;
    }
    const call = this.ask(key, cookie, authorization);
    this.cache.track([key], call);
    return call;
  }

  /** Drops every session of `userId`: it was revoked, or may no longer be served. */
  purgeUser(userId: AuthContext['userId']) {
    this.purges += 1;
    this.cache.deleteWhere((auth) => auth.userId === userId);
    // A call already in flight may be about to say the session is fine: later requests must not
    // join it, and its answer is not cached (the purge count moved).
    this.cache.clearPending();
  }

  private async ask(key: string, cookie: string, authorization: string): Promise<SessionOutcome> {
    const purgesBefore = this.purges;
    let outcome: SessionOutcome;
    try {
      const reply = SessionResolverWire.output.parse(
        await this.client.request('POST', SESSION_RESOLVER_ROUTE, {
          ...(cookie ? { cookie } : {}),
          ...(authorization ? { authorization } : {}),
        }),
      );
      outcome = {
        ...(reply.auth ? { auth: reply.auth } : {}),
        ...(reply.sessionEndedReason ? { sessionEndedReason: reply.sessionEndedReason } : {}),
      };
    } catch (err) {
      this.noteFailure(err);
      return isUnreachable(err) ? { unavailable: true } : {};
    }
    if (outcome.auth && purgesBefore === this.purges) {
      this.cache.set(key, outcome.auth);
    }
    return outcome;
  }

  // The first failure is logged in full; while failures continue, one summary per interval with
  // how many it stands for and the kind of the latest, so an outage is one line, not one per request.
  private noteFailure(err: unknown) {
    const now = this.now();
    if (this.lastLoggedAt !== undefined && now - this.lastLoggedAt < FAILURE_LOG_INTERVAL_MS) {
      this.failuresSinceLog += 1;
      return;
    }
    logger.error(
      {
        err,
        kind: err instanceof InternalApiError ? err.kind : 'invalid_reply',
        suppressedSinceLastLog: this.failuresSinceLog,
      },
      'identity could not resolve a session; the request is not authenticated',
    );
    this.lastLoggedAt = now;
    this.failuresSinceLog = 0;
  }
}

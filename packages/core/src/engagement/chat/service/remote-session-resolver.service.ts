import { createHash } from 'node:crypto';
import {
  createLogger,
  SESSION_RESOLVER_ROUTE,
  SessionResolverWire,
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
// ponytail: per-process cache with oldest-first eviction; past this many live credentials the
// oldest are asked again early, which is only slower, never wrong.
const SESSION_CACHE_MAX_ENTRIES = 10_000;

const logger = createLogger('chat-remote-session');

// Keyed by a digest, so a credential never sits in this process's memory as a map key, and a
// heap dump does not hand out session tokens. The separator keeps ("a", "b") and ("ab", "") apart.
const credentialKey = (cookie: string, authorization: string) =>
  createHash('sha256').update(`${cookie}\0${authorization}`).digest('hex');

type CachedSession = { auth: AuthContext; expiresAt: number };

/**
 * {@link RequestSessionResolver} over the identity service's internal API, for a service whose
 * database has no session tables. Identity runs the whole chain (session, idle window,
 * second-factor flag, last-seen stamp) on the forwarded credentials. A confirmed session is kept
 * for {@link SESSION_CACHE_TTL_MS}; a refusal (no session, idle, expired) is never kept, so a
 * session that was just refused or has just been re-established is asked again on the next
 * request. Any failed call resolves as unauthenticated: a request is never served on a stale or
 * guessed identity because identity could not be reached.
 */
export class RemoteSessionResolver implements RequestSessionResolver {
  private readonly cache = new Map<string, CachedSession>();
  // Calls in flight, by credential, so a page's burst of parallel requests makes one call.
  private readonly inFlight = new Map<string, Promise<SessionOutcome>>();
  // Bumped by every purge: an answer read before a purge must not be cached after it.
  private purges = 0;

  constructor(
    private readonly client: InternalClient,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(headers: Headers): Promise<SessionOutcome> {
    const cookie = headers.get('cookie') ?? '';
    const authorization = headers.get('authorization') ?? '';
    if (!cookie && !authorization) {
      return {};
    }
    const key = credentialKey(cookie, authorization);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return { auth: cached.auth };
    }
    const pending = this.inFlight.get(key) ?? this.ask(key, cookie, authorization);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === pending) {
        this.inFlight.delete(key);
      }
    }
  }

  /** Drops every session of `userId`: it was revoked, or may no longer be served. */
  purgeUser(userId: AuthContext['userId']) {
    this.purges += 1;
    for (const [key, { auth }] of this.cache) {
      if (auth.userId === userId) {
        this.cache.delete(key);
      }
    }
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
      logger.error({ err }, 'identity could not resolve a session; the request is unauthenticated');
      return {};
    }
    if (outcome.auth && purgesBefore === this.purges) {
      this.remember(key, outcome.auth);
    }
    return outcome;
  }

  private remember(key: string, auth: AuthContext) {
    this.cache.delete(key);
    this.cache.set(key, { auth, expiresAt: this.now() + SESSION_CACHE_TTL_MS });
    if (this.cache.size > SESSION_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
  }
}

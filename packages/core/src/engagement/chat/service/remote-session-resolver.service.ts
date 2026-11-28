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

const SESSION_CACHE_TTL_MS = 5_000;
const SESSION_CACHE_MAX_ENTRIES = 10_000;
const FAILURE_LOG_INTERVAL_MS = 30_000;

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

const credentialKey = (cookie: string, authorization: string) =>
  createHash('sha256').update(`${cookie}\0${authorization}`).digest('hex');

const isUnreachable = (err: unknown) => err instanceof InternalApiError && err.kind !== 'client';

const logger = createLogger('chat-remote-session');

export class RemoteSessionResolver implements RequestSessionResolver {
  private readonly cache: TtlCache<AuthContext, SessionOutcome>;
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

  purgeUser(userId: AuthContext['userId']) {
    this.purges += 1;
    this.cache.deleteWhere((auth) => auth.userId === userId);
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

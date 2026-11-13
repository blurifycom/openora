import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InternalApiError,
  SESSION_RESOLVER_ROUTE,
  setErrorReporter,
  SessionResolverWire,
  type InternalClient,
} from '@openora/core/server';
import {
  FAILURE_LOG_INTERVAL_MS,
  RemoteSessionResolver,
  SESSION_CACHE_TTL_MS,
} from '../service/remote-session-resolver.service.js';

type Reply = ReturnType<typeof SessionResolverWire.output.parse>;
type Sent = { cookie?: string | undefined; authorization?: string | undefined };

const SESSION_COOKIE = 'better-auth.session_token';
const tokenOf = (cookie: string | undefined) => cookie?.match(/session_token=([^;]*)/)?.[1] ?? '';

/** An identity service that knows `sessions` (by token), counts its calls, and can fail. */
function identityService(sessions: Map<string, Reply> = new Map()) {
  const sent: Sent[] = [];
  const state: { fail: (() => never) | undefined } = { fail: undefined };
  const client: InternalClient = {
    async request(method, path, body) {
      state.fail?.();
      expect([method, path]).toEqual(['POST', SESSION_RESOLVER_ROUTE]);
      const input = SessionResolverWire.input.parse(body);
      sent.push(input);
      return sessions.get(tokenOf(input.cookie)) ?? { auth: null };
    },
  };
  return { client, sent, sessions, state };
}

const userId = randomUUID();
const sessionFor = (id = userId): Reply => ({ auth: { userId: id, sessionId: randomUUID() } });
const cookie = (token: string) => new Headers({ cookie: `${SESSION_COOKIE}=${token}` });

function setup() {
  const identity = identityService(new Map([['live', sessionFor()]]));
  const clock = { now: 1_000_000 };
  const resolver = new RemoteSessionResolver(identity.client, () => clock.now);
  return { identity, clock, resolver };
}
const keysOf = (resolver: RemoteSessionResolver) =>
  [...Reflect.get(Reflect.get(resolver, 'cache') as object, 'entries').keys()] as string[];
const reportedErrors = () => {
  const reporter = vi.fn();
  setErrorReporter(reporter);
  return reporter;
};

afterEach(() => setErrorReporter(undefined));

describe('RemoteSessionResolver', () => {
  it('serves a confirmed session from its cache within the TTL, then asks again', async () => {
    const { identity, clock, resolver } = setup();

    const first = await resolver.resolve(cookie('live'));
    clock.now += SESSION_CACHE_TTL_MS - 1;
    const withinTtl = await resolver.resolve(cookie('live'));
    expect(identity.sent).toHaveLength(1);
    clock.now += 1;
    const afterTtl = await resolver.resolve(cookie('live'));

    expect(first.auth?.userId).toBe(userId);
    expect(withinTtl).toEqual(first);
    expect(afterTtl).toEqual(first);
    expect(identity.sent).toHaveLength(2);
  });

  it('carries the second-factor flag and the session id through', async () => {
    const reply: Reply = { auth: { userId, sessionId: 's1', twoFactorSetupRequired: true } };
    const resolver = new RemoteSessionResolver(identityService(new Map([['live', reply]])).client);

    expect((await resolver.resolve(cookie('live'))).auth).toEqual(reply.auth);
  });

  it('refuses a revoked session once its user is purged, and spares other users', async () => {
    const { identity, resolver } = setup();
    const otherId = randomUUID();
    identity.sessions.set('other', sessionFor(otherId));
    await resolver.resolve(cookie('live'));
    await resolver.resolve(cookie('other'));
    identity.sessions.delete('live');

    // Until the revocation reaches this process, the cached session is served: the TTL is the bound.
    expect((await resolver.resolve(cookie('live'))).auth?.userId).toBe(userId);
    resolver.purgeUser(userId);

    expect(await resolver.resolve(cookie('live'))).toEqual({});
    expect((await resolver.resolve(cookie('other'))).auth?.userId).toBe(otherId);
    expect(identity.sent.map((call) => tokenOf(call.cookie))).toEqual(['live', 'other', 'live']);
  });

  it('never caches a refusal, whether unknown, expired or idle', async () => {
    const { identity, resolver } = setup();
    identity.sessions.set('idle', { auth: null, sessionEndedReason: 'idle_timeout' });

    expect(await resolver.resolve(cookie('unknown'))).toEqual({});
    expect(await resolver.resolve(cookie('unknown'))).toEqual({});
    expect(await resolver.resolve(cookie('idle'))).toEqual({ sessionEndedReason: 'idle_timeout' });
    identity.sessions.set('idle', { auth: null });
    expect(await resolver.resolve(cookie('idle'))).toEqual({});
    expect(identity.sent).toHaveLength(4);
    identity.sessions.set('unknown', sessionFor());

    expect((await resolver.resolve(cookie('unknown'))).auth?.userId).toBe(userId);
  });

  it('makes no call for a request without credentials', async () => {
    const { identity, resolver } = setup();

    expect(await resolver.resolve(new Headers())).toEqual({});
    expect(identity.sent).toEqual([]);
  });

  it('forwards only the session cookies and the authorization header', async () => {
    const { identity, resolver } = setup();

    await resolver.resolve(
      new Headers({
        cookie: `_ga=GA1; ${SESSION_COOKIE}=live; consent=yes; theme=dark`,
        authorization: 'Bearer t',
        'x-user-id': 'someone-else',
      }),
    );
    await resolver.resolve(new Headers({ cookie: `__Secure-${SESSION_COOKIE}=live; _ga=GA2` }));

    expect(identity.sent).toEqual([
      { cookie: `${SESSION_COOKIE}=live`, authorization: 'Bearer t' },
      { cookie: `__Secure-${SESSION_COOKIE}=live` },
    ]);
  });

  it('makes no call, and caches nothing, for a jar without a session cookie', async () => {
    const { identity, resolver } = setup();

    expect(await resolver.resolve(new Headers({ cookie: '_ga=GA1; consent=yes' }))).toEqual({});
    expect(await resolver.resolve(new Headers({ cookie: `x${SESSION_COOKIE}=live` }))).toEqual({});
    expect(await resolver.resolve(new Headers({ cookie: SESSION_COOKIE }))).toEqual({});

    expect(identity.sent).toEqual([]);
    expect(keysOf(resolver)).toEqual([]);
  });

  it('shares one cache entry between jars that differ only outside the session cookie', async () => {
    const { identity, resolver } = setup();

    await resolver.resolve(new Headers({ cookie: `_ga=1; ${SESSION_COOKIE}=live` }));
    await resolver.resolve(new Headers({ cookie: `${SESSION_COOKIE}=live; _ga=2; extra=3` }));

    expect(identity.sent).toHaveLength(1);
  });

  it('marks identity as unavailable when it cannot be reached, and a refusal as unauthenticated', async () => {
    const { identity, clock, resolver } = setup();
    reportedErrors();
    expect((await resolver.resolve(cookie('live'))).auth).toBeDefined();
    clock.now += SESSION_CACHE_TTL_MS;

    for (const [failure, outcome] of [
      [new InternalApiError('timeout', 'timed out'), { unavailable: true }],
      [new InternalApiError('server', 'bad gateway', { status: 502 }), { unavailable: true }],
      [new InternalApiError('network', 'fetch failed'), { unavailable: true }],
      [new InternalApiError('client', 'refused', { status: 403 }), {}],
    ] as const) {
      identity.state.fail = () => {
        throw failure;
      };
      // A failed call is never answered from what it had before.
      expect(await resolver.resolve(cookie('live')), String(failure)).toEqual(outcome);
    }
    identity.state.fail = undefined;

    expect((await resolver.resolve(cookie('live'))).auth?.userId).toBe(userId);
  });

  it('treats a reply it cannot parse as unauthenticated', async () => {
    reportedErrors();
    const resolver = new RemoteSessionResolver({ request: async () => ({ auth: { userId: 7 } }) });

    expect(await resolver.resolve(cookie('live'))).toEqual({});
  });

  it('logs the first failure, then one summary per interval rather than one per request', async () => {
    const reporter = reportedErrors();
    const clock = { now: 1_000_000 };
    const resolver = new RemoteSessionResolver(
      {
        request: async () => {
          throw new InternalApiError('timeout', 'timed out');
        },
      },
      () => clock.now,
    );

    for (let i = 0; i < 50; i++) {
      await resolver.resolve(cookie(`token-${i}`));
    }
    expect(reporter).toHaveBeenCalledTimes(1);

    clock.now += FAILURE_LOG_INTERVAL_MS;
    await resolver.resolve(cookie('again'));
    await resolver.resolve(cookie('again-2'));

    expect(reporter).toHaveBeenCalledTimes(2);
  });

  it('keeps the credential out of its cache keys', async () => {
    const { resolver } = setup();
    await resolver.resolve(cookie('live'));

    const keys = keysOf(resolver);

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain('live');
  });

  it('tells two credentials apart however they split between cookie and authorization', async () => {
    const request = vi.fn<InternalClient['request']>(async () => sessionFor());
    const resolver = new RemoteSessionResolver({ request });

    await resolver.resolve(new Headers({ cookie: `${SESSION_COOKIE}=a`, authorization: 'b' }));
    await resolver.resolve(new Headers({ cookie: `${SESSION_COOKIE}=ab` }));
    await resolver.resolve(new Headers({ authorization: 'ab' }));

    expect(request).toHaveBeenCalledTimes(3);
  });

  it('makes one call for a burst of requests with one credential', async () => {
    const { identity, resolver } = setup();

    await Promise.all(Array.from({ length: 5 }, () => resolver.resolve(cookie('live'))));

    expect(identity.sent).toHaveLength(1);
  });

  it('does not cache an answer that a purge overtook', async () => {
    const { identity } = setup();
    const resolver: RemoteSessionResolver = new RemoteSessionResolver({
      request: async (method, path, body) => {
        const reply = await identity.client.request(method, path, body);
        resolver.purgeUser(userId);
        return reply;
      },
    });

    await resolver.resolve(cookie('live'));
    await resolver.resolve(cookie('live'));

    expect(identity.sent).toHaveLength(2);
  });

  it('does not let a request after a purge join a call that started before it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answers = [sessionFor(), { auth: null }] satisfies Reply[];
    const request = vi.fn<InternalClient['request']>(async () => {
      const answer = answers.shift() ?? { auth: null };
      await gate;
      return answer;
    });
    const resolver = new RemoteSessionResolver({ request });

    const before = resolver.resolve(cookie('live'));
    resolver.purgeUser(userId);
    const after = resolver.resolve(cookie('live'));
    release();

    expect(request).toHaveBeenCalledTimes(2);
    expect((await before).auth?.userId).toBe(userId);
    expect(await after).toEqual({});
  });

  it('keeps its cache within its bound', async () => {
    const request = vi.fn<InternalClient['request']>(async (_method, _path, body) => ({
      auth: { userId: JSON.stringify(body) },
    }));
    const resolver = new RemoteSessionResolver({ request });

    for (let i = 0; i < 10_050; i++) {
      await resolver.resolve(cookie(`token-${i}`));
    }

    expect(keysOf(resolver)).toHaveLength(10_000);
  });
});

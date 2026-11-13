import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InternalApiError,
  SESSION_RESOLVER_ROUTE,
  SessionResolverWire,
  type InternalClient,
} from '@openora/core/server';
import {
  RemoteSessionResolver,
  SESSION_CACHE_TTL_MS,
} from '../service/remote-session-resolver.service.js';

type Reply = ReturnType<typeof SessionResolverWire.output.parse>;
type Sent = { cookie?: string | undefined; authorization?: string | undefined };

/** An identity service that knows `sessions` (by cookie), counts its calls, and can fail. */
function identityService(sessions: Map<string, Reply> = new Map()) {
  const sent: Sent[] = [];
  const state: { fail: (() => never) | undefined } = { fail: undefined };
  const client: InternalClient = {
    async request(method, path, body) {
      state.fail?.();
      expect([method, path]).toEqual(['POST', SESSION_RESOLVER_ROUTE]);
      const input = SessionResolverWire.input.parse(body);
      sent.push(input);
      return sessions.get(input.cookie ?? '') ?? { auth: null };
    },
  };
  return { client, sent, sessions, state };
}

const userId = randomUUID();
const sessionFor = (id = userId): Reply => ({ auth: { userId: id, sessionId: randomUUID() } });
const cookie = (token: string) => new Headers({ cookie: token });

function setup() {
  const identity = identityService(new Map([['live', sessionFor()]]));
  const clock = { now: 1_000_000 };
  const resolver = new RemoteSessionResolver(identity.client, () => clock.now);
  return { identity, clock, resolver };
}
const cacheOf = (resolver: RemoteSessionResolver) =>
  Reflect.get(resolver, 'cache') as Map<string, unknown>;

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
    expect(identity.sent.map((call) => call.cookie)).toEqual(['live', 'other', 'live']);
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

  it('forwards the cookie and the authorization header, and nothing else', async () => {
    const { identity, resolver } = setup();

    await resolver.resolve(
      new Headers({ cookie: 'a=1', authorization: 'Bearer t', 'x-user-id': 'someone-else' }),
    );

    expect(identity.sent).toEqual([{ cookie: 'a=1', authorization: 'Bearer t' }]);
  });

  it('treats a failed call as unauthenticated, never as the last answer it had', async () => {
    const { identity, clock, resolver } = setup();
    expect((await resolver.resolve(cookie('live'))).auth).toBeDefined();
    clock.now += SESSION_CACHE_TTL_MS;

    for (const failure of [
      new InternalApiError('timeout', 'timed out'),
      new InternalApiError('server', 'bad gateway', { status: 502 }),
      new InternalApiError('client', 'refused', { status: 403 }),
      new TypeError('fetch failed'),
    ]) {
      identity.state.fail = () => {
        throw failure;
      };
      expect(await resolver.resolve(cookie('live'))).toEqual({});
    }
    identity.state.fail = undefined;

    expect((await resolver.resolve(cookie('live'))).auth?.userId).toBe(userId);
  });

  it('treats a reply it cannot parse as unauthenticated', async () => {
    const resolver = new RemoteSessionResolver({ request: async () => ({ auth: { userId: 7 } }) });

    expect(await resolver.resolve(cookie('live'))).toEqual({});
  });

  it('keeps the credential out of its cache keys', async () => {
    const { resolver } = setup();
    await resolver.resolve(cookie('live'));

    const keys = [...cacheOf(resolver).keys()];

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain('live');
  });

  it('tells two credentials apart however they split between cookie and authorization', async () => {
    const request = vi.fn<InternalClient['request']>(async () => sessionFor());
    const resolver = new RemoteSessionResolver({ request });

    await resolver.resolve(new Headers({ cookie: 'a', authorization: 'b' }));
    await resolver.resolve(new Headers({ cookie: 'ab' }));
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

  it('keeps its cache within its bound', async () => {
    const request = vi.fn<InternalClient['request']>(async (_method, _path, body) => ({
      auth: { userId: JSON.stringify(body) },
    }));
    const resolver = new RemoteSessionResolver({ request });

    for (let i = 0; i < 10_050; i++) {
      await resolver.resolve(cookie(`token-${i}`));
    }

    expect(cacheOf(resolver).size).toBe(10_000);
  });
});

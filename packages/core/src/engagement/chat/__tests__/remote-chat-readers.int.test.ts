import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_READER_ROUTES } from '@openora/core/contracts';
import {
  InternalApiError,
  SESSION_RESOLVER_ROUTE,
  setErrorReporter,
  type RequestSessionResolver,
} from '@openora/core/server';
import { seedPlayerWithUser } from '../../../testing/seed-player.js';
import {
  startRemoteIdentity,
  type RemoteIdentity,
} from '../../../testing/remote-identity-harness.js';
import { RemoteAccountReader } from '../service/remote-account-reader.service.js';
import { RemoteSessionResolver } from '../service/remote-session-resolver.service.js';

const SESSION_COOKIE = 'better-auth.session_token';

const sessions = new Map<string, string>();

const identityResolver: RequestSessionResolver = {
  async resolve(headers) {
    const token = headers.get('cookie')?.split('=')[1];
    const userId = token === undefined ? undefined : sessions.get(token);
    return userId === undefined ? {} : { auth: { userId, sessionId: `session-${userId}` } };
  },
};

const pathCalls = (identity: RemoteIdentity, path: string) =>
  identity.calls.filter((call) => call.path === path).length;

let identity: RemoteIdentity;

beforeAll(async () => {
  identity = await startRemoteIdentity(identityResolver);
}, 120_000);

afterAll(async () => {
  await identity.stop();
  await identity.dispose();
}, 60_000);

describe('remote account reader', () => {
  it('a resolved account is returned and the second read is served from cache', async () => {
    const { account } = await seedPlayerWithUser(identity.testDb);
    const reader = new RemoteAccountReader(identity.client);
    const before = pathCalls(identity, ACCOUNT_READER_ROUTES.accounts);

    const first = await reader.getAccounts([account.id]);
    const second = await reader.getAccounts([account.id]);

    expect(first.get(account.id)).toEqual(
      expect.objectContaining({ userId: account.id, username: account.username }),
    );
    expect(second.get(account.id)).toEqual(first.get(account.id));
    expect(pathCalls(identity, ACCOUNT_READER_ROUTES.accounts) - before).toBe(1);
  });

  it('a remote failure makes the reader fail closed', async () => {
    const down = await startRemoteIdentity(identityResolver);
    try {
      const { account } = await seedPlayerWithUser(down.testDb);
      await down.stop();
      const reader = new RemoteAccountReader(down.client);

      await expect(reader.getAccounts([account.id])).rejects.toBeInstanceOf(InternalApiError);
    } finally {
      await down.dispose();
    }
  });

  it.todo(
    'GAP: a remote failure is logged and the reader fails closed (RemoteAccountReader rethrows and logs nothing)',
  );

  it('a missing account is not cached as present', async () => {
    const reader = new RemoteAccountReader(identity.client);
    const userId = randomUUID();
    const before = pathCalls(identity, ACCOUNT_READER_ROUTES.accounts);

    const absent = await reader.getAccounts([userId]);
    await seedPlayerWithUser(identity.testDb, { userId });
    const present = await reader.getAccounts([userId]);

    expect(absent.size).toBe(0);
    expect(present.get(userId)).toEqual(expect.objectContaining({ userId }));
    expect(pathCalls(identity, ACCOUNT_READER_ROUTES.accounts) - before).toBe(2);
  });
});

describe('remote session resolver', () => {
  it('a valid session resolves to the player and is cached', async () => {
    const userId = randomUUID();
    const token = randomUUID();
    sessions.set(token, userId);
    const resolver = new RemoteSessionResolver(identity.client);
    const headers = new Headers({ cookie: `${SESSION_COOKIE}=${token}` });
    const before = pathCalls(identity, SESSION_RESOLVER_ROUTE);

    const first = await resolver.resolve(headers);
    const second = await resolver.resolve(headers);

    expect(first.auth?.userId).toBe(userId);
    expect(second).toEqual(first);
    expect(pathCalls(identity, SESSION_RESOLVER_ROUTE) - before).toBe(1);
  });

  it('an invalid session resolves to no session and is asked again', async () => {
    const resolver = new RemoteSessionResolver(identity.client);
    const headers = new Headers({ cookie: `${SESSION_COOKIE}=${randomUUID()}` });
    const before = pathCalls(identity, SESSION_RESOLVER_ROUTE);

    const first = await resolver.resolve(headers);
    const second = await resolver.resolve(headers);

    expect(first).toEqual({});
    expect(second).toEqual({});
    expect(pathCalls(identity, SESSION_RESOLVER_ROUTE) - before).toBe(2);
  });

  it('a remote failure is logged and resolves to no session', async () => {
    const down = await startRemoteIdentity(identityResolver);
    const reported: unknown[] = [];
    setErrorReporter((error) => reported.push(error));
    try {
      await down.stop();
      const resolver = new RemoteSessionResolver(down.client);

      const outcome = await resolver.resolve(
        new Headers({ cookie: `${SESSION_COOKIE}=${randomUUID()}` }),
      );

      expect(outcome).toEqual({ unavailable: true });
      expect(outcome.auth).toBeUndefined();
      expect(reported).toHaveLength(1);
      expect(reported[0]).toBeInstanceOf(InternalApiError);
    } finally {
      setErrorReporter(undefined);
      await down.dispose();
    }
  });
});

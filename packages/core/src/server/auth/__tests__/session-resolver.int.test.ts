import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { SessionResolver } from '../session-resolver.js';

const { createAuthMock, getSessionMock } = vi.hoisted(() => ({
  createAuthMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('../auth.js', () => ({
  createAuth: createAuthMock.mockImplementation(() => ({
    api: { getSession: getSessionMock },
  })),
}));

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(() => {
  createAuthMock.mockClear();
  getSessionMock.mockClear();
  getSessionMock.mockResolvedValue(null);
});

describe('SessionResolver (real PG-backed drizzle)', () => {
  it('hands the drizzle db and the injected schema to better-auth exactly once', () => {
    const schema = { session: {} };

    new SessionResolver(db.drizzle, schema);

    expect(createAuthMock).toHaveBeenCalledTimes(1);
    expect(createAuthMock).toHaveBeenCalledWith({ db: db.drizzle.db, schema });
  });

  it('omits the schema key when none is injected', () => {
    new SessionResolver(db.drizzle);

    expect(createAuthMock).toHaveBeenCalledWith({ db: db.drizzle.db });
  });

  it('returns undefined when there is no session', async () => {
    const resolver = new SessionResolver(db.drizzle);

    expect(await resolver.resolveUserId(new Headers())).toBeUndefined();
  });

  it('returns the user id when a session resolves', async () => {
    const userId = randomUUID();
    getSessionMock.mockResolvedValueOnce({ user: { id: userId } });
    const resolver = new SessionResolver(db.drizzle);

    expect(await resolver.resolveUserId(new Headers())).toBe(userId);
  });

  it('forwards the caller headers to better-auth', async () => {
    const resolver = new SessionResolver(db.drizzle);
    const headers = new Headers({ cookie: 'session=abc' });

    await resolver.resolveUserId(headers);

    expect(getSessionMock).toHaveBeenCalledWith({ headers });
  });

  it('returns undefined for a session without a user', async () => {
    getSessionMock.mockResolvedValueOnce({});
    const resolver = new SessionResolver(db.drizzle);

    expect(await resolver.resolveUserId(new Headers())).toBeUndefined();
  });
});

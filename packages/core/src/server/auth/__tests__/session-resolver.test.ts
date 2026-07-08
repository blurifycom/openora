import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../../../testing/mock.js';
import { SessionResolver } from '../session-resolver.js';

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn().mockResolvedValue(null),
}));

vi.mock('../auth.js', () => ({
  createAuth: vi.fn(() => ({ api: { getSession: getSessionMock } })),
}));

beforeEach(() => {
  getSessionMock.mockClear();
  getSessionMock.mockResolvedValue(null);
});

describe('SessionResolver.resolveUserId', () => {
  it('returns undefined when there is no session', async () => {
    const resolver = new SessionResolver(mockDb({}));

    const userId = await resolver.resolveUserId(new Headers());

    expect(userId).toBeUndefined();
  });

  it('returns the user id when a session resolves', async () => {
    getSessionMock.mockResolvedValueOnce({ user: { id: 'u1' } });
    const resolver = new SessionResolver(mockDb({}));

    const userId = await resolver.resolveUserId(new Headers());

    expect(userId).toBe('u1');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdentityService } from '../service/identity.service.js';
import { UnsupportedLanguageError } from '../../shared/language.js';
import type { SendEmailPort } from '@blurifycom/core/contracts';

const { signInEmailMock, getSessionMock, updateUserMock } = vi.hoisted(() => ({
  signInEmailMock: vi.fn(),
  getSessionMock: vi.fn().mockResolvedValue(null),
  updateUserMock: vi.fn(),
}));

vi.mock('@blurifycom/core/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAuth: vi.fn(() => ({
    api: {
      getSession: getSessionMock,
      signUpEmail: vi.fn(),
      signInEmail: signInEmailMock,
      signOut: vi.fn(),
      updateUser: updateUserMock,
    },
  })),
}));

type DrizzleRows = { selectRows?: unknown[][]; updateReturning?: unknown[][] };

function makeDrizzle({ selectRows = [], updateReturning = [] }: DrizzleRows = {}) {
  const selectQueue = [...selectRows];
  const returningQueue = [...updateReturning];
  const update = vi.fn(() => ({
    set: () => ({
      where: () =>
        Object.assign(Promise.resolve(undefined), {
          returning: () => Promise.resolve(returningQueue.shift() ?? []),
        }),
    }),
  }));
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(selectQueue.shift() ?? []) }) }),
  }));
  return { db: { select, update }, update, select };
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn() };
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const betterAuthUser = {
  id: 'u1',
  email: 'a@b.dev',
  name: 'A',
  emailVerified: true,
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(null);
});

describe('IdentityService - SendEmailPort seam', () => {
  it('constructs without a SendEmailPort (email delivery silently skipped)', () => {
    const svc = new IdentityService({
      drizzle: makeDrizzle() as never,
      events: makeEvents() as never,
    });
    expect(svc).toBeInstanceOf(IdentityService);
  });

  it('constructs with a stub SendEmailPort and exposes it for use', () => {
    const stub: SendEmailPort = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new IdentityService({
      drizzle: makeDrizzle() as never,
      events: makeEvents() as never,
      email: stub,
    });
    expect(svc).toBeInstanceOf(IdentityService);
  });

  it('me returns null when no session exists', async () => {
    const svc = new IdentityService({
      drizzle: makeDrizzle() as never,
      events: makeEvents() as never,
    });
    const result = await svc.me({});
    expect(result).toBeNull();
  });
});

describe('IdentityService - login lockout', () => {
  it('locks the account once failed attempts reach the threshold and emits lockout.triggered', async () => {
    const drizzle = makeDrizzle({
      selectRows: [[{ id: 'u1', failedLoginAttempts: 4, lockoutUntil: null }]],
      updateReturning: [[{ failedLoginAttempts: 5 }]],
    });
    const events = makeEvents();
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'Invalid' }, 401));
    const svc = new IdentityService({ drizzle: drizzle as never, events: events as never });

    await expect(
      svc.login({ email: 'A@B.dev', password: 'wrongpass1' }, {}, new Headers()),
    ).rejects.toThrow();

    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.lockout.triggered',
      expect.objectContaining({ userId: 'u1', email: 'a@b.dev' }),
    );
  });

  it('emits login.failed (not lockout) while still below the threshold', async () => {
    const drizzle = makeDrizzle({
      selectRows: [[{ id: 'u1', failedLoginAttempts: 0, lockoutUntil: null }]],
      updateReturning: [[{ failedLoginAttempts: 1 }]],
    });
    const events = makeEvents();
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'Invalid' }, 401));
    const svc = new IdentityService({ drizzle: drizzle as never, events: events as never });

    await expect(
      svc.login({ email: 'a@b.dev', password: 'wrongpass1' }, {}, new Headers()),
    ).rejects.toThrow();

    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.login.failed',
      expect.objectContaining({ email: 'a@b.dev', reason: 'invalid_credentials' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.user.lockout.triggered',
      expect.anything(),
    );
  });

  it('rejects a currently-locked account before attempting sign-in', async () => {
    const future = new Date(Date.now() + 60_000);
    const drizzle = makeDrizzle({
      selectRows: [[{ id: 'u1', failedLoginAttempts: 5, lockoutUntil: future }]],
    });
    const svc = new IdentityService({ drizzle: drizzle as never, events: makeEvents() as never });

    await expect(
      svc.login({ email: 'a@b.dev', password: 'whatever1' }, {}, new Headers()),
    ).rejects.toThrow();
    expect(signInEmailMock).not.toHaveBeenCalled();
  });

  it('clears the counter and emits login on success', async () => {
    const drizzle = makeDrizzle({
      selectRows: [[{ id: 'u1', failedLoginAttempts: 2, lockoutUntil: null }]],
    });
    const events = makeEvents();
    signInEmailMock.mockResolvedValue(
      jsonResponse(
        { user: betterAuthUser, token: 'tok', session: { expiresAt: '2020-02-01T00:00:00.000Z' } },
        200,
      ),
    );
    const svc = new IdentityService({ drizzle: drizzle as never, events: events as never });

    const result = await svc.login({ email: 'a@b.dev', password: 'rightpass1' }, {}, new Headers());

    expect(result).toMatchObject({ session: { token: 'tok' } });
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.login',
      expect.objectContaining({ userId: 'u1' }),
    );
    expect(drizzle.update).toHaveBeenCalled();
  });
});

describe('IdentityService - unlockUser', () => {
  it('clears the lockout and emits unlocked with the prior state', async () => {
    const drizzle = makeDrizzle({
      selectRows: [
        [
          {
            id: 'u1',
            email: 'a@b.dev',
            failedLoginAttempts: 5,
            lockoutUntil: new Date('2020-01-01T00:00:00.000Z'),
          },
        ],
      ],
    });
    const events = makeEvents();
    const svc = new IdentityService({ drizzle: drizzle as never, events: events as never });

    const res = await svc.unlockUser('u1', 'admin1');

    expect(res).toEqual({ success: true });
    expect(drizzle.update).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unlocked',
      expect.objectContaining({
        userId: 'u1',
        actorId: 'admin1',
        previousFailedAttempts: 5,
        previousLockoutUntil: '2020-01-01T00:00:00.000Z',
      }),
    );
  });

  it('throws when the user does not exist', async () => {
    const drizzle = makeDrizzle({ selectRows: [[]] });
    const svc = new IdentityService({ drizzle: drizzle as never, events: makeEvents() as never });
    await expect(svc.unlockUser('missing', 'admin1')).rejects.toThrow();
  });
});

describe('IdentityService.updateProfile language validation', () => {
  it('rejects an unsupported language before calling updateUser', async () => {
    const svc = new IdentityService({
      drizzle: makeDrizzle() as never,
      events: makeEvents() as never,
      platformConfig: { supportedLanguages: ['en', 'fr'] } as never,
    });

    await expect(svc.updateProfile({ language: 'de' }, {}, new Headers())).rejects.toThrow(
      UnsupportedLanguageError,
    );
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it('accepts a supported language and forwards it to updateUser', async () => {
    updateUserMock.mockResolvedValue(jsonResponse({ status: true }, 200));
    getSessionMock.mockResolvedValueOnce({ user: { ...betterAuthUser, language: 'fr' } });
    const svc = new IdentityService({
      drizzle: makeDrizzle() as never,
      events: makeEvents() as never,
      platformConfig: { supportedLanguages: ['en', 'fr'] } as never,
    });

    const result = await svc.updateProfile({ language: 'fr' }, {}, new Headers());

    expect(updateUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ language: 'fr' }) }),
    );
    expect(result.user.language).toBe('fr');
  });
});

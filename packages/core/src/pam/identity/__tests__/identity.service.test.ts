import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdentityService, SESSION_DURATION_IN_SECONDS } from '../service/identity.service.js';
import { UnsupportedLanguageError } from '../../shared/language.js';
import type { SendEmailPort } from '@openora/core/contracts';
import { ORPCError } from '@orpc/server';

const { signInEmailMock, getSessionMock, updateUserMock } = vi.hoisted(() => ({
  signInEmailMock: vi.fn(),
  getSessionMock: vi.fn().mockResolvedValue(null),
  updateUserMock: vi.fn(),
}));

vi.mock('@openora/core/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAuth: vi.fn(() => ({
    options: {
      session: {
        expiresIn: SESSION_DURATION_IN_SECONDS,
      },
    },
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

    const promise = svc.login({ email: 'a@b.dev', password: 'whatever1' }, {}, new Headers());
    await expect(promise).rejects.toThrow(ORPCError);
    await expect(promise).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Account is temporarily locked. Please try again later.',
      data: {
        code: 'ACCOUNT_LOCKED',
        lockoutUntil: future.toISOString(),
      },
    });
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

  it('bypasses lockout for admins if configured with bypassForAdmins: true', async () => {
    const drizzle = makeDrizzle({
      selectRows: [[{ id: 'u1', failedLoginAttempts: 4, lockoutUntil: null, role: 'admin' }]],
    });
    const events = makeEvents();
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'Invalid' }, 401));
    const svc = new IdentityService({
      drizzle: drizzle as never,
      events: events as never,
      options: {
        lockout: {
          enabled: true,
          bypassForAdmins: true,
        },
      },
    });

    await expect(
      svc.login({ email: 'admin@b.dev', password: 'wrongpass1' }, {}, new Headers()),
    ).rejects.toThrow();

    // It should not increment the failed attempts or trigger lockout
    expect(drizzle.update).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.login.failed',
      expect.objectContaining({ email: 'admin@b.dev' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.user.lockout.triggered',
      expect.anything(),
    );
  });

  it('does not bypass lockout for other backoffice roles if bypassForAdmins is true', async () => {
    const drizzle = makeDrizzle({
      selectRows: [
        [{ id: 'u1', failedLoginAttempts: 4, lockoutUntil: null, role: 'support' }],
        [{ failedLoginAttempts: 5 }],
      ],
    });
    const events = makeEvents();
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'Invalid' }, 401));
    const svc = new IdentityService({
      drizzle: drizzle as never,
      events: events as never,
      options: {
        lockout: {
          enabled: true,
          bypassForAdmins: true,
          maxAttempts: 5,
        },
      },
    });

    await expect(
      svc.login({ email: 'support@b.dev', password: 'wrongpass1' }, {}, new Headers()),
    ).rejects.toThrow();

    // It should increment the failed attempts and trigger lockout
    expect(drizzle.update).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.lockout.triggered',
      expect.objectContaining({ userId: 'u1', email: 'support@b.dev' }),
    );
  });
});

describe('IdentityService - RG login gate', () => {
  it('blocks a self-excluded login AFTER credentials verify and emits rg.exclusion.login_blocked', async () => {
    const drizzle = makeDrizzle({
      selectRows: [
        [
          {
            id: 'u1',
            failedLoginAttempts: 0,
            lockoutUntil: null,
            rgBlocked: true,
            rgBlockedUntil: null,
          },
        ],
      ],
    });
    const events = makeEvents();
    // Valid credentials (200) - the gate must still block.
    signInEmailMock.mockResolvedValue(
      jsonResponse({ user: betterAuthUser, token: 'tok', session: {} }, 200),
    );
    const svc = new IdentityService({ drizzle: drizzle as never, events: events as never });

    await expect(
      svc.login({ email: 'a@b.dev', password: 'rightpass1' }, {}, new Headers()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(signInEmailMock).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.exclusion.login_blocked',
      expect.objectContaining({ userId: 'u1' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('identity.user.login', expect.anything());
    expect(events.emit).not.toHaveBeenCalledWith('identity.user.login.failed', expect.anything());
    // The just-issued session is revoked.
    expect(drizzle.update).toHaveBeenCalled();
  });

  it('allows login once a lapsed cooling-off block has elapsed', async () => {
    const past = new Date(Date.now() - 60_000);
    const drizzle = makeDrizzle({
      selectRows: [
        [
          {
            id: 'u1',
            failedLoginAttempts: 0,
            lockoutUntil: null,
            rgBlocked: true,
            rgBlockedUntil: past,
          },
        ],
      ],
    });
    const events = makeEvents();
    signInEmailMock.mockResolvedValue(
      jsonResponse({ user: betterAuthUser, token: 'tok', session: {} }, 200),
    );
    const svc = new IdentityService({ drizzle: drizzle as never, events: events as never });

    const result = await svc.login({ email: 'a@b.dev', password: 'rightpass1' }, {}, new Headers());

    expect(result).toMatchObject({ session: { token: 'tok' } });
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.login',
      expect.objectContaining({ userId: 'u1' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('rg.exclusion.login_blocked', expect.anything());
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

  it('resets the login rate-limit window for the unlocked user', async () => {
    const drizzle = makeDrizzle({
      selectRows: [
        [
          {
            id: 'u1',
            email: 'A@B.DEV',
            failedLoginAttempts: 5,
            lockoutUntil: new Date('2020-01-01'),
          },
        ],
      ],
    });
    const resetMock = vi.fn().mockResolvedValue(undefined);
    const limiter = {
      consume: vi.fn(),
      reset: resetMock,
    } satisfies import('@openora/core/contracts').RateLimiterAdapter;
    const svc = new IdentityService({
      drizzle: drizzle as never,
      events: makeEvents() as never,
      limiter,
    });

    await svc.unlockUser('u1', 'admin1');

    expect(resetMock).toHaveBeenCalledWith('login:a@b.dev');
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

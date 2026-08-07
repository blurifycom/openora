import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ORPCError } from '@orpc/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import type {
  EmailTemplateRenderer,
  PlatformConfig,
  RateLimiterAdapter,
} from '@openora/core/contracts';
import {
  IdentityService,
  SESSION_DURATION_IN_SECONDS,
  type IdentityServiceDeps,
} from '../service/identity.service.js';
import { UnsupportedLanguageError } from '../../shared/language.js';
import { user, session } from '../schema/index.js';
import { mock, makeEventBus } from '../../../testing/mock.js';

const {
  signInEmailMock,
  getSessionMock,
  updateUserMock,
  requestPasswordResetEmailOTPMock,
  checkVerificationOTPMock,
  resetPasswordEmailOTPMock,
  capturedAuthOptions,
} = vi.hoisted(() => ({
  signInEmailMock: vi.fn(),
  getSessionMock: vi.fn().mockResolvedValue(null),
  updateUserMock: vi.fn(),
  requestPasswordResetEmailOTPMock: vi.fn(),
  checkVerificationOTPMock: vi.fn(),
  resetPasswordEmailOTPMock: vi.fn(),
  capturedAuthOptions: {
    current: undefined as
      | { onPasswordReset?: (user: { id: string; email: string }) => Promise<void> | void }
      | undefined,
  },
}));

vi.mock('@openora/core/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAuth: vi.fn((options) => {
    capturedAuthOptions.current = options;
    return {
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
        requestPasswordResetEmailOTP: requestPasswordResetEmailOTPMock,
        checkVerificationOTP: checkVerificationOTPMock,
        resetPasswordEmailOTP: resetPasswordEmailOTPMock,
      },
    };
  }),
}));

const { RedisCache } = await import('@openora/core/server');

let db: TestDb;
let redis: TestRedis;

const allowLimiter = () =>
  mock<RateLimiterAdapter>({
    consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    reset: vi.fn().mockResolvedValue(undefined),
  });

const testTemplateRenderer: EmailTemplateRenderer = {
  render: () => ({ subject: 'subject', body: 'body' }),
};

function buildService(deps: Partial<Omit<IdentityServiceDeps, 'templateRenderer'>> = {}) {
  return new IdentityService({
    templateRenderer: testTemplateRenderer,
    drizzle: db.drizzle,
    events: makeEventBus(),
    ...deps,
  });
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

const EMAIL = 'a@b.dev';

async function seedUser(over: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({ name: 'A', email: EMAIL, emailVerified: true, ...over })
    .returning();
  return row;
}

async function readUser(userId: string) {
  const [row] = await db.drizzle.db.select().from(user).where(eq(user.id, userId));
  return row;
}

const realCache = () => new RedisCache(redis.client);

const signInSuccess = (userId: string) =>
  jsonResponse(
    {
      user: { ...betterAuthUser, id: userId },
      token: 'tok',
      session: { expiresAt: '2020-02-01T00:00:00.000Z' },
    },
    200,
  );

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(null);
  await db.drizzle.db.execute(
    sql`TRUNCATE ${user}, ${session}, ${player} RESTART IDENTITY CASCADE`,
  );
  await redis.flush();
});

describe('IdentityService.me', () => {
  it('returns null when no session exists', async () => {
    expect(await buildService().me({})).toBeNull();
  });
});

describe('IdentityService - login lockout (real PG + real Redis)', () => {
  it('locks the account once failed attempts reach the threshold and emits lockout.triggered', async () => {
    const account = await seedUser({ failedLoginAttempts: 4 });
    const events = makeEventBus();
    const limiter = allowLimiter();
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'Invalid' }, 401));
    const svc = buildService({ events, limiter });

    await expect(
      svc.login({ email: 'A@B.dev', password: 'wrongpass1' }, {}, new Headers()),
    ).rejects.toThrow();

    const row = await readUser(account.id);
    expect(row.failedLoginAttempts).toBe(5);
    expect(row.lockoutUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(row.lockoutCount).toBe(1);
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.lockout.triggered',
      expect.objectContaining({ userId: account.id, email: EMAIL }),
    );
    expect(limiter.reset).toHaveBeenCalledWith(`login:${EMAIL}`);
  });

  it('escalates the lockout duration on a repeat lockout inside the 24h window', async () => {
    const account = await seedUser({
      failedLoginAttempts: 4,
      lockoutCount: 1,
      lastLockoutAt: new Date(Date.now() - 60_000),
    });
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'Invalid' }, 401));
    const svc = buildService();

    await expect(
      svc.login({ email: EMAIL, password: 'wrongpass1' }, {}, new Headers()),
    ).rejects.toThrow();

    const row = await readUser(account.id);
    expect(row.lockoutCount).toBe(2);
    expect(row.lockoutUntil?.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('emits login.failed (not lockout) while still below the threshold', async () => {
    const account = await seedUser();
    const events = makeEventBus();
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'Invalid' }, 401));
    const svc = buildService({ events });

    await expect(
      svc.login({ email: EMAIL, password: 'wrongpass1' }, {}, new Headers()),
    ).rejects.toThrow();

    const row = await readUser(account.id);
    expect(row.failedLoginAttempts).toBe(1);
    expect(row.lockoutUntil).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.login.failed',
      expect.objectContaining({ email: EMAIL, reason: 'invalid_credentials' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.user.lockout.triggered',
      expect.anything(),
    );
  });

  it('counts concurrent credential failures exactly once each (atomic SQL increment)', async () => {
    const account = await seedUser();
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'Invalid' }, 401));
    const svc = buildService();

    await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        svc.login({ email: EMAIL, password: 'wrongpass1' }, {}, new Headers()),
      ),
    );

    expect((await readUser(account.id)).failedLoginAttempts).toBe(3);
  });

  it('rejects a currently-locked account before attempting sign-in', async () => {
    const future = new Date(Date.now() + 60_000);
    await seedUser({ failedLoginAttempts: 5, lockoutUntil: future });
    const svc = buildService();

    const promise = svc.login({ email: EMAIL, password: 'whatever1' }, {}, new Headers());
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
    const account = await seedUser({ failedLoginAttempts: 2 });
    const events = makeEventBus();
    signInEmailMock.mockResolvedValue(signInSuccess(account.id));
    const svc = buildService({ events });

    const result = await svc.login({ email: EMAIL, password: 'rightpass1' }, {}, new Headers());

    expect(result).toMatchObject({ session: { token: 'tok' } });
    expect((await readUser(account.id)).failedLoginAttempts).toBe(0);
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.login',
      expect.objectContaining({ userId: account.id }),
    );
  });

  it('bypasses lockout for admins if configured with bypassForAdmins: true', async () => {
    const account = await seedUser({
      email: 'admin@b.dev',
      role: 'admin',
      failedLoginAttempts: 4,
    });
    const events = makeEventBus();
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'Invalid' }, 401));
    const svc = buildService({
      events,
      options: { lockout: { enabled: true, bypassForAdmins: true } },
    });

    await expect(
      svc.login({ email: 'admin@b.dev', password: 'wrongpass1' }, {}, new Headers()),
    ).rejects.toThrow();

    const row = await readUser(account.id);
    expect(row.failedLoginAttempts).toBe(4);
    expect(row.lockoutUntil).toBeNull();
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
    const account = await seedUser({
      email: 'support@b.dev',
      role: 'support',
      failedLoginAttempts: 4,
    });
    const events = makeEventBus();
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'Invalid' }, 401));
    const svc = buildService({
      events,
      options: { lockout: { enabled: true, bypassForAdmins: true, maxAttempts: 5 } },
    });

    await expect(
      svc.login({ email: 'support@b.dev', password: 'wrongpass1' }, {}, new Headers()),
    ).rejects.toThrow();

    const row = await readUser(account.id);
    expect(row.failedLoginAttempts).toBe(5);
    expect(row.lockoutUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.lockout.triggered',
      expect.objectContaining({ userId: account.id, email: 'support@b.dev' }),
    );
  });

  it('anti-enumeration: locks a nonexistent email once failed attempts reach the threshold, mirroring a real account, without emitting lockout.triggered', async () => {
    const events = makeEventBus();
    const limiter = allowLimiter();
    signInEmailMock.mockImplementation(async () => jsonResponse({ message: 'Invalid' }, 401));
    const svc = buildService({ events, limiter, cache: realCache() });

    for (let i = 0; i < 4; i++) {
      await expect(
        svc.login({ email: 'nobody@b.dev', password: 'wrongpass1' }, {}, new Headers()),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid' });
    }

    await expect(
      svc.login({ email: 'nobody@b.dev', password: 'wrongpass1' }, {}, new Headers()),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      data: { code: 'ACCOUNT_LOCKED' },
    });

    expect(limiter.reset).toHaveBeenCalledWith('login:nobody@b.dev');
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.user.lockout.triggered',
      expect.anything(),
    );
  });

  it('anti-enumeration: the shadow lockout survives a fresh service instance (state lives in Redis, not memory)', async () => {
    signInEmailMock.mockImplementation(async () => jsonResponse({ message: 'Invalid' }, 401));

    for (let i = 0; i < 5; i++) {
      const svc = buildService({ cache: realCache() });
      await expect(
        svc.login({ email: 'nobody@b.dev', password: 'wrongpass1' }, {}, new Headers()),
      ).rejects.toThrow();
    }

    await expect(
      buildService({ cache: realCache() }).login(
        { email: 'nobody@b.dev', password: 'wrongpass1' },
        {},
        new Headers(),
      ),
    ).rejects.toMatchObject({ data: { code: 'ACCOUNT_LOCKED' } });
  });

  it('never locks a nonexistent email when cache is not provided (degrades to the pre-mirroring behavior)', async () => {
    const events = makeEventBus();
    signInEmailMock.mockImplementation(async () => jsonResponse({ message: 'Invalid' }, 401));
    const svc = buildService({ events });

    for (let i = 0; i < 6; i++) {
      await expect(
        svc.login({ email: 'nobody@b.dev', password: 'wrongpass1' }, {}, new Headers()),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid' });
    }

    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.user.lockout.triggered',
      expect.anything(),
    );
  });
});

describe('IdentityService - login banned-user 403 (not the RG block)', () => {
  it('surfaces a banned-user 403 from signInEmail as FORBIDDEN and still emits login.failed', async () => {
    await seedUser();
    const events = makeEventBus();
    signInEmailMock.mockResolvedValue(jsonResponse({ message: 'BANNED_USER' }, 403));
    const svc = buildService({ events });

    await expect(
      svc.login({ email: EMAIL, password: 'whatever1' }, {}, new Headers()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.login.failed',
      expect.objectContaining({ email: EMAIL, reason: 'error' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('rg.exclusion.login_blocked', expect.anything());
  });
});

describe('IdentityService - RG login gate (real PG)', () => {
  it('blocks a self-excluded login AFTER credentials verify, expires the issued session, and emits rg.exclusion.login_blocked', async () => {
    const account = await seedUser({ rgBlocked: true, rgBlockedUntil: null });
    const live = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.drizzle.db
      .insert(session)
      .values({ userId: account.id, token: randomUUID(), expiresAt: live });
    const events = makeEventBus();
    // Valid credentials (200) - the gate must still block.
    signInEmailMock.mockResolvedValue(signInSuccess(account.id));
    const svc = buildService({ events });

    await expect(
      svc.login({ email: EMAIL, password: 'rightpass1' }, {}, new Headers()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(signInEmailMock).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.exclusion.login_blocked',
      expect.objectContaining({ userId: account.id }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('identity.user.login', expect.anything());
    expect(events.emit).not.toHaveBeenCalledWith('identity.user.login.failed', expect.anything());

    const [revoked] = await db.drizzle.db
      .select()
      .from(session)
      .where(eq(session.userId, account.id));
    expect(revoked.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('allows login once a lapsed cooling-off block has elapsed', async () => {
    const account = await seedUser({
      rgBlocked: true,
      rgBlockedUntil: new Date(Date.now() - 60_000),
    });
    const events = makeEventBus();
    signInEmailMock.mockResolvedValue(signInSuccess(account.id));
    const svc = buildService({ events });

    const result = await svc.login({ email: EMAIL, password: 'rightpass1' }, {}, new Headers());

    expect(result).toMatchObject({ session: { token: 'tok' } });
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.login',
      expect.objectContaining({ userId: account.id }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('rg.exclusion.login_blocked', expect.anything());
  });
});

describe('IdentityService - player-status login gate (real PG)', () => {
  async function seedBlockedPlayer(status: 'suspended' | 'closed') {
    const account = await seedUser();
    await db.drizzle.db.insert(player).values({ userId: account.id, displayName: 'x', status });
    const live = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.drizzle.db
      .insert(session)
      .values({ userId: account.id, token: randomUUID(), expiresAt: live });
    return account;
  }

  for (const status of ['suspended', 'closed'] as const) {
    it(`blocks a ${status} player AFTER credentials verify, expires the issued session, and emits player.login_blocked`, async () => {
      const account = await seedBlockedPlayer(status);
      const events = makeEventBus();
      // Valid credentials (200) - the gate must still block.
      signInEmailMock.mockResolvedValue(signInSuccess(account.id));
      const svc = buildService({ events });

      await expect(
        svc.login({ email: EMAIL, password: 'rightpass1' }, {}, new Headers()),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', data: { code: 'ACCOUNT_SUSPENDED' } });

      expect(signInEmailMock).toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith(
        'player.login_blocked',
        expect.objectContaining({ userId: account.id, status }),
      );
      expect(events.emit).not.toHaveBeenCalledWith('identity.user.login', expect.anything());
      expect(events.emit).not.toHaveBeenCalledWith('identity.user.login.failed', expect.anything());

      const [revoked] = await db.drizzle.db
        .select()
        .from(session)
        .where(eq(session.userId, account.id));
      expect(revoked.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    });
  }

  it('allows login for an active player (no regression)', async () => {
    const account = await seedUser();
    await db.drizzle.db
      .insert(player)
      .values({ userId: account.id, displayName: 'x', status: 'active' });
    const events = makeEventBus();
    signInEmailMock.mockResolvedValue(signInSuccess(account.id));
    const svc = buildService({ events });

    const result = await svc.login({ email: EMAIL, password: 'rightpass1' }, {}, new Headers());

    expect(result).toMatchObject({ session: { token: 'tok' } });
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.login',
      expect.objectContaining({ userId: account.id }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('player.login_blocked', expect.anything());
  });
});

describe('IdentityService.unlockUser (real PG)', () => {
  it('clears the lockout row and emits unlocked with the prior state', async () => {
    const lockedUntil = new Date('2020-01-01T00:00:00.000Z');
    const account = await seedUser({ failedLoginAttempts: 5, lockoutUntil: lockedUntil });
    const events = makeEventBus();
    const svc = buildService({ events });

    const res = await svc.unlockUser(account.id, 'admin1');

    expect(res).toEqual({ success: true });
    const row = await readUser(account.id);
    expect(row.failedLoginAttempts).toBe(0);
    expect(row.lockoutUntil).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unlocked',
      expect.objectContaining({
        userId: account.id,
        actorId: 'admin1',
        previousFailedAttempts: 5,
        previousLockoutUntil: lockedUntil.toISOString(),
      }),
    );
  });

  it('throws when the user does not exist', async () => {
    await expect(buildService().unlockUser(randomUUID(), 'admin1')).rejects.toThrow();
  });

  it('resets the login rate-limit window for the unlocked user', async () => {
    const account = await seedUser({
      failedLoginAttempts: 5,
      lockoutUntil: new Date('2020-01-01'),
    });
    const limiter = allowLimiter();
    const svc = buildService({ limiter });

    await svc.unlockUser(account.id, 'admin1');

    expect(limiter.reset).toHaveBeenCalledWith(`login:${EMAIL}`);
  });
});

describe('IdentityService.requestPasswordReset', () => {
  it('calls the non-deprecated requestPasswordResetEmailOTP endpoint and returns SUCCESS', async () => {
    requestPasswordResetEmailOTPMock.mockResolvedValue(jsonResponse({ success: true }, 200));

    const result = await buildService().requestPasswordReset({ email: EMAIL });

    expect(result).toEqual({ success: true });
    expect(requestPasswordResetEmailOTPMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: EMAIL } }),
    );
  });

  it('swallows a failure and still returns SUCCESS (anti-enumeration)', async () => {
    requestPasswordResetEmailOTPMock.mockRejectedValue(new Error('boom'));

    await expect(
      buildService().requestPasswordReset({ email: 'unregistered@x.dev' }),
    ).resolves.toEqual({ success: true });
  });
});

describe('IdentityService.verifyPasswordResetOtp', () => {
  it('calls checkVerificationOTP with type forget-password and returns SUCCESS', async () => {
    checkVerificationOTPMock.mockResolvedValue(jsonResponse({ success: true }, 200));

    const result = await buildService().verifyPasswordResetOtp({ email: EMAIL, otp: '123456' });

    expect(result).toEqual({ success: true });
    expect(checkVerificationOTPMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { email: EMAIL, type: 'forget-password', otp: '123456' },
      }),
    );
  });

  it('surfaces an invalid OTP (400) response as ORPCError BAD_REQUEST with a generic message', async () => {
    checkVerificationOTPMock.mockResolvedValue(jsonResponse({ message: 'INVALID_OTP' }, 400));

    await expect(
      buildService().verifyPasswordResetOtp({ email: EMAIL, otp: '000000' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Invalid or expired verification code',
    });
  });

  it('does not leak better-auth USER_NOT_FOUND message - forces the same generic message as a wrong OTP (anti-enumeration)', async () => {
    // better-auth's checkVerificationOTP checks findUserByEmail BEFORE the OTP row, so an
    // unregistered email produces a distinct raw message ("User not found") that must never
    // reach the caller - it would let an unauthenticated caller learn whether an email exists.
    checkVerificationOTPMock.mockResolvedValue(jsonResponse({ message: 'User not found' }, 400));

    await expect(
      buildService().verifyPasswordResetOtp({ email: 'unregistered@x.dev', otp: '000000' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Invalid or expired verification code',
    });
  });

  it('surfaces a TOO_MANY_ATTEMPTS (403) response as ORPCError BAD_REQUEST (masked)', async () => {
    checkVerificationOTPMock.mockResolvedValue(jsonResponse({ message: 'TOO_MANY_ATTEMPTS' }, 403));

    await expect(
      buildService().verifyPasswordResetOtp({ email: EMAIL, otp: '000000' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('IdentityService.resetPassword', () => {
  it('calls resetPasswordEmailOTP with the right body and returns SUCCESS', async () => {
    resetPasswordEmailOTPMock.mockResolvedValue(jsonResponse({ success: true }, 200));

    const result = await buildService().resetPassword({
      email: EMAIL,
      otp: '123456',
      newPassword: 'newpassword1',
    });

    expect(result).toEqual({ success: true });
    expect(resetPasswordEmailOTPMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { email: EMAIL, otp: '123456', password: 'newpassword1' },
      }),
    );
  });

  it('surfaces a TOO_MANY_ATTEMPTS (403) response as ORPCError BAD_REQUEST (masked)', async () => {
    resetPasswordEmailOTPMock.mockResolvedValue(
      jsonResponse({ message: 'TOO_MANY_ATTEMPTS' }, 403),
    );

    await expect(
      buildService().resetPassword({ email: EMAIL, otp: '000000', newPassword: 'newpassword1' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('IdentityService onPasswordReset hook (wired via createAuth)', () => {
  it('clears the lockout row and emits identity.password.reset when better-auth invokes the hook', async () => {
    const account = await seedUser({
      failedLoginAttempts: 5,
      lockoutUntil: new Date(Date.now() + 60_000),
    });
    const events = makeEventBus();
    buildService({ events });

    await capturedAuthOptions.current?.onPasswordReset?.({ id: account.id, email: EMAIL });

    expect(events.emit).toHaveBeenCalledWith(
      'identity.password.reset',
      expect.objectContaining({ userId: account.id }),
    );
    const row = await readUser(account.id);
    expect(row.failedLoginAttempts).toBe(0);
    expect(row.lockoutUntil).toBeNull();
  });
});

describe('IdentityService.updateProfile language validation', () => {
  it('rejects an unsupported language before calling updateUser', async () => {
    const svc = buildService({
      platformConfig: mock<PlatformConfig>({ supportedLanguages: ['en', 'fr'] }),
    });

    await expect(svc.updateProfile({ language: 'de' }, {}, new Headers())).rejects.toThrow(
      UnsupportedLanguageError,
    );
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it('accepts a supported language and forwards it to updateUser', async () => {
    updateUserMock.mockResolvedValue(jsonResponse({ status: true }, 200));
    getSessionMock.mockResolvedValueOnce({ user: { ...betterAuthUser, language: 'fr' } });
    const svc = buildService({
      platformConfig: mock<PlatformConfig>({ supportedLanguages: ['en', 'fr'] }),
    });

    const result = await svc.updateProfile({ language: 'fr' }, {}, new Headers());

    expect(updateUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ language: 'fr' }) }),
    );
    expect(result.user.language).toBe('fr');
  });
});

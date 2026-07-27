import { createHash, createHmac } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { ORPCError } from '@orpc/server';
import { PhoneLoginService } from '../service/phone-login.service.js';
import { makeDrizzle, makeEvents, mock, NO_CLIENT_META } from '../../../testing/mock.js';
import { InProcessCache } from '../../../testing/fakes/cache.js';
import type { DrizzleService, EventBus, Auth } from '@openora/core/server';
import type { CacheAdapter, RateLimiterAdapter, SmsAdapter } from '@openora/core/contracts';

const PHONE = '+14155550100';

const AUTH_SECRET = 'unit-test-secret-do-not-use-in-prod';
const SESSION_COOKIE_NAME = 'better-auth.session_token';
const DONT_REMEMBER_COOKIE_NAME = 'better-auth.dont_remember';

const fakeAuth: Auth = mock<Auth>({
  $context: Promise.resolve({
    secret: AUTH_SECRET,
    authCookies: {
      sessionToken: {
        name: SESSION_COOKIE_NAME,
        attributes: {
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          path: '/',
          maxAge: 7 * 24 * 60 * 60,
        },
      },
      dontRememberToken: {
        name: DONT_REMEMBER_COOKIE_NAME,
        attributes: {
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          path: '/',
        },
      },
    },
  }),
});

// A verified-phone user row as `verifyOtp`'s `select().from(user)` returns it.
const userRow = {
  id: 'u1',
  email: 'a@b.dev',
  name: 'A',
  emailVerified: true,
  image: null,
  theme: 'system',
  language: 'en',
  phoneNumber: PHONE,
  phoneVerified: true,
  rgBlocked: false,
  rgBlockedUntil: null,
  createdAt: new Date('2020-01-01T00:00:00.000Z'),
  updatedAt: new Date('2020-01-01T00:00:00.000Z'),
};

const allowLimiter = (): RateLimiterAdapter => ({
  consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
  reset: vi.fn(),
});

function build({
  select = [],
  returning = [],
  sms = { sendOtp: vi.fn().mockResolvedValue(undefined) },
  cache,
}: {
  select?: unknown[][];
  returning?: unknown[][];
  sms?: SmsAdapter;
  cache?: CacheAdapter;
} = {}) {
  const drizzle = makeDrizzle({
    select: select as never,
    returning: returning as never,
  });
  const events = makeEvents();
  const svc = new PhoneLoginService({
    drizzle: drizzle as unknown as DrizzleService,
    events: mock<EventBus>(events),
    sms,
    limiter: allowLimiter(),
    auth: fakeAuth,
    cache,
  });
  return { svc, events, sms };
}

function expectedSignature(token: string): string {
  return createHmac('sha256', AUTH_SECRET).update(token).digest('base64');
}

const otpRow = (over: Record<string, unknown> = {}) => ({
  id: 'otp1',
  userId: 'u1',
  codeHash: '', // set per-test
  expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  failedAttempts: 0,
  ...over,
});

// SHA-256 of a code, mirroring the service's hashCode.
const hash = (code: string) => createHash('sha256').update(code).digest('hex');

describe('PhoneLoginService.requestOtp', () => {
  it('sends an OTP for a verified phone and emits requested', async () => {
    // select order: (1) user lookup, (2) existing-otp lookup (none),
    // (3) delete (awaited), (4) insert (awaited).
    const { svc, events, sms } = build({
      select: [[{ id: 'u1', phoneVerified: true }], [], [], []],
    });

    const out = await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });

    expect(typeof out.expiresAt).toBe('string');
    expect(typeof out.resendAfter).toBe('string');
    expect(sms.sendOtp).toHaveBeenCalledWith(
      expect.objectContaining({ to: PHONE, code: expect.stringMatching(/^\d{6}$/) }),
    );
    expect(events.emit).toHaveBeenCalledWith('identity.phone_otp.requested', {
      userId: 'u1',
      ip: null,
      userAgent: null,
    });
  });

  it('anti-enumeration: unknown phone returns success shape without sending SMS', async () => {
    const { svc, events, sms } = build({ select: [[]] });

    const out = await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });

    expect(out).toEqual({ expiresAt: expect.any(String), resendAfter: expect.any(String) });
    expect(sms.sendOtp).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('anti-enumeration: unverified phone returns success shape without sending SMS', async () => {
    const { svc, sms } = build({ select: [[{ id: 'u1', phoneVerified: false }]] });

    const out = await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });
    expect(out).toEqual({ expiresAt: expect.any(String), resendAfter: expect.any(String) });
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('anti-enumeration: unknown phone requested twice within 60s throws OtpCooldownError, mirroring a real resend', async () => {
    const cache = new InProcessCache();
    const { svc, sms } = build({ select: [[], []], cache });

    await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });
    await expect(svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('throws OtpCooldownError when a code was sent under 60s ago', async () => {
    const { svc, sms } = build({
      // (1) user found, (2) existing OTP created 10s ago.
      select: [[{ id: 'u1', phoneVerified: true }], [{ createdAt: new Date(Date.now() - 10_000) }]],
    });

    await expect(svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('supersedes an expired-cooldown prior OTP and emits cancelled(new_otp_requested)', async () => {
    const { svc, events, sms } = build({
      // (1) user, (2) prior OTP older than cooldown, (3) delete, (4) insert.
      select: [
        [{ id: 'u1', phoneVerified: true }],
        [{ createdAt: new Date(Date.now() - 120_000) }],
        [],
        [],
      ],
    });

    await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });

    expect(events.emit).toHaveBeenCalledWith('identity.phone_otp.cancelled', {
      userId: 'u1',
      reason: 'new_otp_requested',
      ip: null,
      userAgent: null,
    });
    expect(sms.sendOtp).toHaveBeenCalled();
  });
});

describe('PhoneLoginService.verifyOtp', () => {
  it('happy path: correct code mints a session and emits phone_login', async () => {
    const code = '123456';
    const { svc, events } = build({
      // (1) otp lookup, (2) user lookup, (3) delete otp in tx, (4) session insert in tx.
      select: [[otpRow({ codeHash: hash(code) })], [userRow], [], []],
    });
    const resHeaders = new Headers();

    const out = await svc.verifyOtp({ phone: PHONE, code, ...NO_CLIENT_META }, resHeaders);

    expect(out.user.id).toBe('u1');
    expect(out.session.token).toEqual(expect.any(String));
    expect(out.session.expiresAt).toEqual(expect.any(String));
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.phone_login',
      expect.objectContaining({ userId: 'u1', method: 'phone' }),
    );
  });

  it('signs a session cookie the same auth instance can verify', async () => {
    const code = '123456';
    const { svc } = build({
      select: [[otpRow({ codeHash: hash(code) })], [userRow], [], []],
    });
    const resHeaders = new Headers();

    const out = await svc.verifyOtp({ phone: PHONE, code, ...NO_CLIENT_META }, resHeaders);

    const setCookie = resHeaders.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('Max-Age');

    const cookieValue = decodeURIComponent(
      setCookie?.split(';')[0]?.split('=').slice(1).join('=') ?? '',
    );
    const sigPos = cookieValue.lastIndexOf('.');
    expect(cookieValue.slice(0, sigPos)).toBe(out.session.token);
    expect(cookieValue.slice(sigPos + 1)).toBe(expectedSignature(out.session.token));
  });

  it('without rememberMe emits a signed dont_remember cookie so getSession will not roll the session to 30 days', async () => {
    const code = '123456';
    const { svc } = build({
      select: [[otpRow({ codeHash: hash(code) })], [userRow], [], []],
    });
    const resHeaders = new Headers();

    await svc.verifyOtp({ phone: PHONE, code, ...NO_CLIENT_META }, resHeaders);

    const dontRemember = resHeaders
      .getSetCookie()
      .find((c) => c.startsWith(`${DONT_REMEMBER_COOKIE_NAME}=`));
    expect(dontRemember).toBeDefined();
    expect(dontRemember).not.toContain('Max-Age');

    const value = decodeURIComponent(
      dontRemember?.split(';')[0]?.split('=').slice(1).join('=') ?? '',
    );
    const sigPos = value.lastIndexOf('.');
    expect(value.slice(0, sigPos)).toBe('true');
    expect(value.slice(sigPos + 1)).toBe(expectedSignature('true'));
  });

  it('rememberMe extends the session TTL to ~30 days and the cookie Max-Age to match', async () => {
    const code = '123456';
    const { svc } = build({
      select: [[otpRow({ codeHash: hash(code) })], [userRow], [], []],
    });
    const resHeaders = new Headers();

    const out = await svc.verifyOtp(
      { phone: PHONE, code, rememberMe: true, ...NO_CLIENT_META },
      resHeaders,
    );
    const ttlMs = new Date(out.session.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);

    const maxAgeMatch = resHeaders.get('set-cookie')?.match(/Max-Age=(\d+)/);
    expect(Number(maxAgeMatch?.[1])).toBeGreaterThan(29 * 24 * 60 * 60);

    const hasDontRemember = resHeaders
      .getSetCookie()
      .some((c) => c.startsWith(`${DONT_REMEMBER_COOKIE_NAME}=`));
    expect(hasDontRemember).toBe(false);
  });

  it('wrong code increments failedAttempts and throws OtpInvalidError with reason "wrong_code"', async () => {
    const { svc, events } = build({
      // (1) otp lookup only (update uses returning, not the select queue).
      select: [[otpRow({ codeHash: hash('000000') })]],
      // update...returning -> 2 attempts used.
      returning: [[{ failedAttempts: 2 }]],
    });

    const promise = svc.verifyOtp(
      { phone: PHONE, code: '111111', ...NO_CLIENT_META },
      new Headers(),
    );
    await expect(promise).rejects.toBeInstanceOf(ORPCError);
    await expect(promise).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      data: { attemptsRemaining: 3, reason: 'wrong_code' },
    });
    expect(events.emit).not.toHaveBeenCalledWith('identity.phone_otp.cancelled', expect.anything());
  });

  it('5th wrong code cancels the session, deletes it, and emits cancelled(max_attempts)', async () => {
    const { svc, events } = build({
      // (1) otp lookup, (2) delete (awaited).
      select: [[otpRow({ codeHash: hash('000000') })], []],
      returning: [[{ failedAttempts: 5 }]],
    });

    await expect(
      svc.verifyOtp({ phone: PHONE, code: '111111', ...NO_CLIENT_META }, new Headers()),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(events.emit).toHaveBeenCalledWith('identity.phone_otp.cancelled', {
      userId: 'u1',
      reason: 'max_attempts',
      ip: null,
      userAgent: null,
    });
  });

  it('expired OTP throws OtpInvalidError with reason "expired", not "wrong_code"', async () => {
    const code = '123456';
    const { svc } = build({
      // 2 failed attempts before the code expired -> 3 remaining
      select: [
        [
          otpRow({
            codeHash: hash(code),
            expiresAt: new Date(Date.now() - 1000),
            failedAttempts: 2,
          }),
        ],
      ],
    });

    await expect(
      svc.verifyOtp({ phone: PHONE, code, ...NO_CLIENT_META }, new Headers()),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      data: { attemptsRemaining: 3, reason: 'expired' },
    });
  });

  it('missing OTP session (anti-enumeration) mimics a real first wrong guess, not "expired"', async () => {
    const { svc } = build({ select: [[]] });
    await expect(
      svc.verifyOtp({ phone: PHONE, code: '123456', ...NO_CLIENT_META }, new Headers()),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      data: { attemptsRemaining: 4, reason: 'wrong_code' },
    });
  });

  it('anti-enumeration: repeated wrong guesses against an unknown phone decrement then cancel, mirroring a real session', async () => {
    const cache = new InProcessCache();
    const { svc, events } = build({ select: [[], [], [], [], [], []], cache });

    await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });

    for (const expected of [4, 3, 2, 1]) {
      await expect(
        svc.verifyOtp({ phone: PHONE, code: 'wrong', ...NO_CLIENT_META }, new Headers()),
      ).rejects.toMatchObject({
        code: 'UNPROCESSABLE_CONTENT',
        data: { attemptsRemaining: expected, reason: 'wrong_code' },
      });
    }

    await expect(
      svc.verifyOtp({ phone: PHONE, code: 'wrong', ...NO_CLIENT_META }, new Headers()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('anti-enumeration: an untouched shadow past the OTP TTL returns "expired", not "wrong_code"', async () => {
    vi.useFakeTimers();
    try {
      const cache = new InProcessCache();
      const { svc } = build({ select: [[], []], cache });

      await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      await expect(
        svc.verifyOtp({ phone: PHONE, code: 'wrong', ...NO_CLIENT_META }, new Headers()),
      ).rejects.toMatchObject({
        code: 'UNPROCESSABLE_CONTENT',
        data: { attemptsRemaining: 5, reason: 'expired' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('RG-blocked user is forbidden after the OTP passes and no session is minted', async () => {
    const code = '123456';
    const { svc, events } = build({
      // (1) otp lookup, (2) blocked user lookup - RG check before tx so OTP is not consumed.
      select: [
        [otpRow({ codeHash: hash(code) })],
        [{ ...userRow, rgBlocked: true, rgBlockedUntil: null }],
      ],
    });
    const resHeaders = new Headers();

    await expect(
      svc.verifyOtp({ phone: PHONE, code, ...NO_CLIENT_META }, resHeaders),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { reason: 'rg_blocked' },
    });
    expect(resHeaders.get('set-cookie')).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'rg.exclusion.login_blocked',
      expect.objectContaining({ userId: 'u1' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('identity.user.phone_login', expect.anything());
  });
});

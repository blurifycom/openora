import { createHash, createHmac, randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { ORPCError } from '@orpc/server';
import { sql } from 'drizzle-orm';
import { RedisCache } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import type { Auth } from '@openora/core/server';
import type { CacheAdapter, RateLimiterAdapter, SmsAdapter } from '@openora/core/contracts';
import { PhoneLoginService } from '../service/phone-login.service.js';
import { user, session, smsOtpSession } from '../schema/index.js';
import { makeEventBus, mock, NO_CLIENT_META } from '../../../testing/mock.js';

const PHONE = '+14155550100';

const AUTH_SECRET = 'unit-test-secret-do-not-use-in-prod';
const SESSION_COOKIE_NAME = 'better-auth.session_token';
const DONT_REMEMBER_COOKIE_NAME = 'better-auth.dont_remember';

const OTP_TTL_MS = 5 * 60 * 1000;

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

let db: TestDb;
let redis: TestRedis;

const allowLimiter = (): RateLimiterAdapter => ({
  consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
  reset: vi.fn(),
});

function build({
  sms = { sendOtp: vi.fn().mockResolvedValue(undefined) },
  cache,
}: { sms?: SmsAdapter; cache?: CacheAdapter } = {}) {
  const events = makeEventBus();
  const svc = new PhoneLoginService({
    drizzle: db.drizzle,
    events: events,
    sms,
    limiter: allowLimiter(),
    auth: fakeAuth,
    cache,
  });
  return { svc, events, sms };
}

const realCache = () => new RedisCache(redis.client);

function expectedSignature(token: string): string {
  return createHmac('sha256', AUTH_SECRET).update(token).digest('base64');
}

// SHA-256 of a code, mirroring the service's hashCode.
const hash = (code: string) => createHash('sha256').update(code).digest('hex');

async function seedUser(over: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({
      name: 'A',
      email: `${randomUUID()}@b.dev`,
      emailVerified: true,
      phoneNumber: PHONE,
      phoneVerified: true,
      ...over,
    })
    .returning();
  return row;
}

async function seedOtp(userId: string, over: Partial<typeof smsOtpSession.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(smsOtpSession)
    .values({
      userId,
      phone: PHONE,
      codeHash: hash('123456'),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      ...over,
    })
    .returning();
  return row;
}

const otpRows = () => db.drizzle.db.select().from(smsOtpSession);
const sessionRows = () => db.drizzle.db.select().from(session);

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${user}, ${session}, ${smsOtpSession}, ${player} RESTART IDENTITY CASCADE`,
  );
  await redis.flush();
});

describe('PhoneLoginService.requestOtp (real PG + real Redis)', () => {
  it('sends an OTP for a verified phone, persists a hashed session row, and emits requested', async () => {
    const account = await seedUser();
    const { svc, events, sms } = build();

    const out = await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });

    expect(typeof out.expiresAt).toBe('string');
    expect(typeof out.resendAfter).toBe('string');
    const sentCode = (sms.sendOtp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.code;
    expect(sentCode).toMatch(/^\d{6}$/);

    const [row] = await otpRows();
    expect(row).toMatchObject({
      userId: account.id,
      phone: PHONE,
      codeHash: hash(sentCode),
      failedAttempts: 0,
    });
    expect(events.emit).toHaveBeenCalledWith('identity.phone_otp.requested', {
      userId: account.id,
      ip: null,
      userAgent: null,
    });
  });

  it('anti-enumeration: unknown phone returns the success shape, writes no row, and sends no SMS', async () => {
    const { svc, events, sms } = build();

    const out = await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });

    expect(out).toEqual({ expiresAt: expect.any(String), resendAfter: expect.any(String) });
    expect(sms.sendOtp).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(await otpRows()).toHaveLength(0);
  });

  it('anti-enumeration: unverified phone returns the success shape and writes no row', async () => {
    await seedUser({ phoneVerified: false });
    const { svc, sms } = build();

    const out = await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });

    expect(out).toEqual({ expiresAt: expect.any(String), resendAfter: expect.any(String) });
    expect(sms.sendOtp).not.toHaveBeenCalled();
    expect(await otpRows()).toHaveLength(0);
  });

  it('anti-enumeration: unknown phone requested twice within 60s throws OtpCooldownError, mirroring a real resend', async () => {
    const { svc, sms } = build({ cache: realCache() });

    await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });
    await expect(svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('throws OtpCooldownError when a code was sent under 60s ago, leaving the stored code untouched', async () => {
    const account = await seedUser();
    const existing = await seedOtp(account.id, { createdAt: new Date(Date.now() - 10_000) });
    const { svc, sms } = build();

    await expect(svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(sms.sendOtp).not.toHaveBeenCalled();
    const [row] = await otpRows();
    expect(row.codeHash).toBe(existing.codeHash);
  });

  it('supersedes an expired-cooldown prior OTP in place and emits cancelled(new_otp_requested)', async () => {
    const account = await seedUser();
    const prior = await seedOtp(account.id, {
      createdAt: new Date(Date.now() - 120_000),
      failedAttempts: 3,
    });
    const { svc, events, sms } = build();

    await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });

    expect(events.emit).toHaveBeenCalledWith('identity.phone_otp.cancelled', {
      userId: account.id,
      reason: 'new_otp_requested',
      ip: null,
      userAgent: null,
    });
    expect(sms.sendOtp).toHaveBeenCalled();
    const rows = await otpRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).not.toBe(prior.codeHash);
    expect(rows[0].failedAttempts).toBe(0);
  });
});

describe('PhoneLoginService.verifyOtp (real PG + real Redis)', () => {
  it('rejects a correct OTP while the account lockout is active', async () => {
    const account = await seedUser({
      failedLoginAttempts: 5,
      lockoutUntil: new Date(Date.now() + 60_000),
    });
    await seedOtp(account.id);
    const { svc } = build();

    await expect(
      svc.verifyOtp({ phone: PHONE, code: '123456', ...NO_CLIENT_META }, new Headers()),
    ).rejects.toMatchObject({
      data: { code: 'ACCOUNT_LOCKED', attemptsRemaining: 0, nextLoginAt: expect.any(String) },
    });
    expect(await sessionRows()).toHaveLength(0);
  });

  it('happy path: correct code mints a session row, consumes the OTP, and emits phone_login', async () => {
    const code = '123456';
    const account = await seedUser();
    await seedOtp(account.id, { codeHash: hash(code) });
    const { svc, events } = build();

    const out = await svc.verifyOtp({ phone: PHONE, code, ...NO_CLIENT_META }, new Headers());

    expect(out.user.id).toBe(account.id);
    expect(out.session.token).toEqual(expect.any(String));

    const sessions = await sessionRows();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ userId: account.id, token: out.session.token });
    expect(new Date(out.session.expiresAt).toISOString()).toBe(sessions[0].expiresAt.toISOString());
    expect(await otpRows()).toHaveLength(0);
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.phone_login',
      expect.objectContaining({ userId: account.id, method: 'phone' }),
    );
  });

  it('signs a session cookie the same auth instance can verify', async () => {
    const code = '123456';
    const account = await seedUser();
    await seedOtp(account.id, { codeHash: hash(code) });
    const { svc } = build();
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
    const account = await seedUser();
    await seedOtp(account.id, { codeHash: hash(code) });
    const { svc } = build();
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

  it('rememberMe extends the persisted session TTL to ~30 days and the cookie Max-Age to match', async () => {
    const code = '123456';
    const account = await seedUser();
    await seedOtp(account.id, { codeHash: hash(code) });
    const { svc } = build();
    const resHeaders = new Headers();

    await svc.verifyOtp({ phone: PHONE, code, rememberMe: true, ...NO_CLIENT_META }, resHeaders);

    const [stored] = await sessionRows();
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);

    const maxAgeMatch = resHeaders.get('set-cookie')?.match(/Max-Age=(\d+)/);
    expect(Number(maxAgeMatch?.[1])).toBeGreaterThan(29 * 24 * 60 * 60);

    const hasDontRemember = resHeaders
      .getSetCookie()
      .some((c) => c.startsWith(`${DONT_REMEMBER_COOKIE_NAME}=`));
    expect(hasDontRemember).toBe(false);
  });

  it('wrong code increments failedAttempts in the row and throws OtpInvalidError with reason "wrong_code"', async () => {
    const account = await seedUser();
    await seedOtp(account.id, { codeHash: hash('000000'), failedAttempts: 1 });
    const { svc, events } = build();

    const promise = svc.verifyOtp(
      { phone: PHONE, code: '111111', ...NO_CLIENT_META },
      new Headers(),
    );
    await expect(promise).rejects.toBeInstanceOf(ORPCError);
    await expect(promise).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      data: { attemptsRemaining: 3, reason: 'wrong_code' },
    });
    const [row] = await otpRows();
    expect(row.failedAttempts).toBe(2);
    expect(events.emit).not.toHaveBeenCalledWith('identity.phone_otp.cancelled', expect.anything());
  });

  it('concurrent wrong guesses each consume exactly one attempt (atomic SQL increment)', async () => {
    const account = await seedUser();
    await seedOtp(account.id, { codeHash: hash('000000') });
    const { svc } = build();

    const attempts = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        svc.verifyOtp({ phone: PHONE, code: '111111', ...NO_CLIENT_META }, new Headers()),
      ),
    );

    expect(attempts.every((a) => a.status === 'rejected')).toBe(true);
    const [row] = await otpRows();
    expect(row.failedAttempts).toBe(3);
  });

  it('5th wrong code deletes the session row and emits cancelled(max_attempts)', async () => {
    const account = await seedUser();
    await seedOtp(account.id, { codeHash: hash('000000'), failedAttempts: 4 });
    const { svc, events } = build();

    await expect(
      svc.verifyOtp({ phone: PHONE, code: '111111', ...NO_CLIENT_META }, new Headers()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await otpRows()).toHaveLength(0);
    expect(events.emit).toHaveBeenCalledWith('identity.phone_otp.cancelled', {
      userId: account.id,
      reason: 'max_attempts',
      ip: null,
      userAgent: null,
    });
  });

  it('expired OTP throws OtpInvalidError with reason "expired", not "wrong_code"', async () => {
    const code = '123456';
    const account = await seedUser();
    await seedOtp(account.id, {
      codeHash: hash(code),
      expiresAt: new Date(Date.now() - 1000),
      failedAttempts: 2,
    });
    const { svc } = build();

    await expect(
      svc.verifyOtp({ phone: PHONE, code, ...NO_CLIENT_META }, new Headers()),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      data: { attemptsRemaining: 3, reason: 'expired' },
    });
  });

  it('missing OTP session (anti-enumeration) mimics a real first wrong guess, not "expired"', async () => {
    const { svc } = build();

    await expect(
      svc.verifyOtp({ phone: PHONE, code: '123456', ...NO_CLIENT_META }, new Headers()),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      data: { attemptsRemaining: 4, reason: 'wrong_code' },
    });
  });

  it('anti-enumeration: repeated wrong guesses against an unknown phone decrement then cancel, mirroring a real session', async () => {
    const { svc, events } = build({ cache: realCache() });

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
    expect(await otpRows()).toHaveLength(0);
  });

  it('anti-enumeration: an untouched shadow past the OTP TTL returns "expired", not "wrong_code"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { svc } = build({ cache: realCache() });

      await svc.requestOtp({ phone: PHONE, ...NO_CLIENT_META });
      vi.setSystemTime(Date.now() + OTP_TTL_MS + 1);

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

  it('RG-blocked user is forbidden after the OTP passes, and neither the session nor the OTP is consumed', async () => {
    const code = '123456';
    const account = await seedUser({ rgBlocked: true, rgBlockedUntil: null });
    await seedOtp(account.id, { codeHash: hash(code) });
    const { svc, events } = build();
    const resHeaders = new Headers();

    await expect(
      svc.verifyOtp({ phone: PHONE, code, ...NO_CLIENT_META }, resHeaders),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { reason: 'rg_blocked' },
    });

    expect(resHeaders.get('set-cookie')).toBeNull();
    expect(await sessionRows()).toHaveLength(0);
    expect(await otpRows()).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledWith(
      'rg.exclusion.login_blocked',
      expect.objectContaining({ userId: account.id }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('identity.user.phone_login', expect.anything());
  });

  it('suspended player is forbidden after the OTP passes, and neither the session nor the OTP is consumed', async () => {
    const code = '123456';
    const account = await seedUser();
    await db.drizzle.db
      .insert(player)
      .values({ userId: account.id, displayName: 'x', status: 'suspended' });
    await seedOtp(account.id, { codeHash: hash(code) });
    const { svc, events } = build();
    const resHeaders = new Headers();

    await expect(
      svc.verifyOtp({ phone: PHONE, code, ...NO_CLIENT_META }, resHeaders),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { reason: 'account_suspended' },
    });

    expect(resHeaders.get('set-cookie')).toBeNull();
    expect(await sessionRows()).toHaveLength(0);
    expect(await otpRows()).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledWith(
      'player.login_blocked',
      expect.objectContaining({ userId: account.id, status: 'suspended' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('identity.user.phone_login', expect.anything());
  });
});

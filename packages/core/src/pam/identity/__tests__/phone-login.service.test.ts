import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { ORPCError } from '@orpc/server';
import { PhoneLoginService } from '../service/phone-login.service.js';
import { makeDrizzle, makeEvents, mock } from '../../../testing/mock.js';
import type { DrizzleService, EventBus } from '@openora/core/server';
import type { RateLimiterAdapter, SmsAdapter } from '@openora/core/contracts';

const PHONE = '+14155550100';

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
});

function build({
  select = [],
  returning = [],
  sms = { sendOtp: vi.fn().mockResolvedValue(undefined) },
}: {
  select?: unknown[][];
  returning?: unknown[][];
  sms?: SmsAdapter;
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
  });
  return { svc, events, sms };
}

const otpRow = (over: Record<string, unknown> = {}) => ({
  id: 'otp1',
  userId: 'u1',
  codeHash: '', // set per-test
  expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  ...over,
});

// SHA-256 of a code, mirroring the service's hashCode.
const hash = (code: string) => createHash('sha256').update(code).digest('hex');

describe('PhoneLoginService.requestOtp', () => {
  it('sends an OTP for a verified phone and emits requested', async () => {
    // select order: (1) user lookup, (2) existing-otp lookup (none),
    // (3) delete (awaited), (4) insert (awaited).
    const { svc, events, sms } = build({
      select: [[{ id: 'u1' }], [], [], []],
    });

    const out = await svc.requestOtp({ phone: PHONE });

    expect(typeof out.expiresAt).toBe('string');
    expect(typeof out.resendAfter).toBe('string');
    expect(sms.sendOtp).toHaveBeenCalledWith(
      expect.objectContaining({ to: PHONE, code: expect.stringMatching(/^\d{6}$/) }),
    );
    expect(events.emit).toHaveBeenCalledWith('identity.phone_otp.requested', { userId: 'u1' });
  });

  it('anti-enumeration: unknown phone returns success shape without sending SMS', async () => {
    const { svc, events, sms } = build({ select: [[]] });

    const out = await svc.requestOtp({ phone: PHONE });

    expect(out).toEqual({ expiresAt: expect.any(String), resendAfter: expect.any(String) });
    expect(sms.sendOtp).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws OtpCooldownError when a code was sent under 60s ago', async () => {
    const { svc, sms } = build({
      // (1) user found, (2) existing OTP created 10s ago.
      select: [[{ id: 'u1' }], [{ createdAt: new Date(Date.now() - 10_000) }]],
    });

    await expect(svc.requestOtp({ phone: PHONE })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('supersedes an expired-cooldown prior OTP and emits cancelled(new_otp_requested)', async () => {
    const { svc, events, sms } = build({
      // (1) user, (2) prior OTP older than cooldown, (3) delete, (4) insert.
      select: [[{ id: 'u1' }], [{ createdAt: new Date(Date.now() - 120_000) }], [], []],
    });

    await svc.requestOtp({ phone: PHONE });

    expect(events.emit).toHaveBeenCalledWith('identity.phone_otp.cancelled', {
      userId: 'u1',
      reason: 'new_otp_requested',
    });
    expect(sms.sendOtp).toHaveBeenCalled();
  });
});

describe('PhoneLoginService.verifyOtp', () => {
  it('happy path: correct code mints a session and emits phone_login', async () => {
    const code = '123456';
    const { svc, events } = build({
      // (1) otp lookup, (2) delete otp, (3) user lookup, (4) session insert.
      select: [[otpRow({ codeHash: hash(code) })], [], [userRow], []],
    });

    const out = await svc.verifyOtp({ phone: PHONE, code });

    expect(out.user.id).toBe('u1');
    expect(out.session.token).toEqual(expect.any(String));
    expect(out.session.expiresAt).toEqual(expect.any(String));
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.phone_login',
      expect.objectContaining({ userId: 'u1', method: 'phone' }),
    );
  });

  it('rememberMe extends the session TTL to ~30 days', async () => {
    const code = '123456';
    const { svc } = build({
      select: [[otpRow({ codeHash: hash(code) })], [], [userRow], []],
    });

    const out = await svc.verifyOtp({ phone: PHONE, code, rememberMe: true });
    const ttlMs = new Date(out.session.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });

  it('wrong code increments failedAttempts and throws OtpInvalidError with attemptsRemaining', async () => {
    const { svc, events } = build({
      // (1) otp lookup only (update uses returning, not the select queue).
      select: [[otpRow({ codeHash: hash('000000') })]],
      // update...returning -> 2 attempts used.
      returning: [[{ failedAttempts: 2 }]],
    });

    const promise = svc.verifyOtp({ phone: PHONE, code: '111111' });
    await expect(promise).rejects.toBeInstanceOf(ORPCError);
    await expect(promise).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      data: { attemptsRemaining: 3 },
    });
    expect(events.emit).not.toHaveBeenCalledWith('identity.phone_otp.cancelled', expect.anything());
  });

  it('5th wrong code cancels the session, deletes it, and emits cancelled(max_attempts)', async () => {
    const { svc, events } = build({
      // (1) otp lookup, (2) delete (awaited).
      select: [[otpRow({ codeHash: hash('000000') })], []],
      returning: [[{ failedAttempts: 5 }]],
    });

    await expect(svc.verifyOtp({ phone: PHONE, code: '111111' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(events.emit).toHaveBeenCalledWith('identity.phone_otp.cancelled', {
      userId: 'u1',
      reason: 'max_attempts',
    });
  });

  it('expired OTP throws OtpInvalidError', async () => {
    const code = '123456';
    const { svc } = build({
      select: [[otpRow({ codeHash: hash(code), expiresAt: new Date(Date.now() - 1000) })]],
    });

    await expect(svc.verifyOtp({ phone: PHONE, code })).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
    });
  });

  it('missing OTP session throws OtpInvalidError', async () => {
    const { svc } = build({ select: [[]] });
    await expect(svc.verifyOtp({ phone: PHONE, code: '123456' })).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
    });
  });

  it('RG-blocked user is forbidden after the OTP passes and no session is minted', async () => {
    const code = '123456';
    const { svc, events } = build({
      // (1) otp lookup, (2) delete otp, (3) blocked user lookup.
      select: [
        [otpRow({ codeHash: hash(code) })],
        [],
        [{ ...userRow, rgBlocked: true, rgBlockedUntil: null }],
      ],
    });

    await expect(svc.verifyOtp({ phone: PHONE, code })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(events.emit).toHaveBeenCalledWith(
      'rg.exclusion.login_blocked',
      expect.objectContaining({ userId: 'u1' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('identity.user.phone_login', expect.anything());
  });
});

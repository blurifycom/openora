import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAuth } from '../auth.js';

const betterAuthMock = vi.hoisted(() => vi.fn());
const emailOTPMock = vi.hoisted(() => vi.fn((opts) => ({ id: 'email-otp', ...opts })));

vi.mock('better-auth', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    betterAuth: betterAuthMock,
  };
});

vi.mock('better-auth/plugins', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    emailOTP: emailOTPMock,
  };
});

describe('createAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('emailOTP plugin - sendVerificationOTP', () => {
    it('dispatches the reset-password template when type is forget-password', async () => {
      const dispatchOtpMail = vi.fn().mockResolvedValue(undefined);

      createAuth({ db: {} as never, dispatchOtpMail });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      await emailOtpOpts.sendVerificationOTP({
        email: 'test@example.com',
        otp: '123456',
        type: 'forget-password',
      });

      expect(dispatchOtpMail).toHaveBeenCalledWith({
        to: 'test@example.com',
        template: { key: 'resetPasswordOtp', data: { otp: '123456', email: 'test@example.com' } },
      });
    });

    it('dispatches the existing-account template when the reset came from a sign-up', async () => {
      // better-auth issues both through the same `forget-password` type, so without the
      // predicate a duplicate sign-up mails a bare "Reset your password" to someone who
      // never asked to reset anything.
      const dispatchOtpMail = vi.fn().mockResolvedValue(undefined);

      createAuth({
        db: {} as never,
        dispatchOtpMail,
        isExistingAccountSignUp: (email) => email === 'test@example.com',
      });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      await emailOtpOpts.sendVerificationOTP({
        email: 'test@example.com',
        otp: '123456',
        type: 'forget-password',
      });

      expect(dispatchOtpMail).toHaveBeenCalledWith({
        to: 'test@example.com',
        template: {
          key: 'existingAccountSignUp',
          data: { otp: '123456', email: 'test@example.com' },
        },
      });
    });

    it('carries the admin-reset origin in the queued template', async () => {
      const dispatchOtpMail = vi.fn().mockResolvedValue(undefined);

      createAuth({
        db: {} as never,
        dispatchOtpMail,
        isAdminPasswordReset: async (email) => email === 'test@example.com',
      });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      await emailOtpOpts.sendVerificationOTP({
        email: 'test@example.com',
        otp: '123456',
        type: 'forget-password',
      });

      expect(dispatchOtpMail).toHaveBeenCalledWith({
        to: 'test@example.com',
        template: {
          key: 'adminResetPasswordOtp',
          data: { otp: '123456', email: 'test@example.com' },
        },
      });
    });

    it('dispatches the verification code template for an email-verification OTP', async () => {
      const dispatchOtpMail = vi.fn().mockResolvedValue(undefined);

      createAuth({ db: {} as never, dispatchOtpMail });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      await emailOtpOpts.sendVerificationOTP({
        email: 'test@example.com',
        otp: '123456',
        type: 'email-verification',
      });

      expect(dispatchOtpMail).toHaveBeenCalledWith({
        to: 'test@example.com',
        template: { key: 'verifyEmail', data: { otp: '123456' } },
      });
    });

    it('dispatches the change-email confirmation with the still-current email read from the live session', async () => {
      const dispatchOtpMail = vi.fn().mockResolvedValue(undefined);
      const getSession = vi.fn().mockResolvedValue({
        user: {
          email: 'old@example.com',
          name: 'Alex Player',
          username: 'alexplayer',
          antiPhishingCode: 'Sunny Meadow',
        },
      });
      betterAuthMock.mockReturnValue({ api: { getSession } });

      createAuth({ db: {} as never, dispatchOtpMail });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      const request = new Request('https://example.com', { headers: { cookie: 'session=abc' } });
      await emailOtpOpts.sendVerificationOTP(
        { email: 'new@example.com', otp: '123456', type: 'change-email' },
        request,
      );

      expect(getSession).toHaveBeenCalledWith({ headers: request.headers });
      expect(dispatchOtpMail).toHaveBeenCalledWith({
        to: 'new@example.com',
        template: {
          key: 'emailChangeConfirmation',
          data: { otp: '123456', oldEmail: 'o***@example.com', newEmail: 'new@example.com' },
        },
        recipientName: 'alexplayer',
        antiPhishingCode: 'Sunny Meadow',
      });
    });

    it('refuses to send a change-email code it cannot attribute to a live session', async () => {
      const dispatchOtpMail = vi.fn().mockResolvedValue(undefined);
      const getSession = vi.fn().mockResolvedValue(null);
      betterAuthMock.mockReturnValue({ api: { getSession } });

      createAuth({ db: {} as never, dispatchOtpMail });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      await expect(
        emailOtpOpts.sendVerificationOTP(
          { email: 'new@example.com', otp: '123456', type: 'change-email' },
          undefined,
        ),
      ).rejects.toThrow('change-email OTP requested without a resolvable session');
      expect(dispatchOtpMail).not.toHaveBeenCalled();
    });

    it('returns early without dispatching mail for other types', async () => {
      const dispatchOtpMail = vi.fn();

      createAuth({ db: {} as never, dispatchOtpMail });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      await emailOtpOpts.sendVerificationOTP({
        email: 'test@example.com',
        otp: '123456',
        type: 'sign-in',
      });

      expect(dispatchOtpMail).not.toHaveBeenCalled();
    });
  });

  describe('email verification gate', () => {
    it('does not require a verified address by default', () => {
      // Unverified players stay unrestricted while the KYC toggle is off.
      createAuth({ db: {} as never });

      expect(betterAuthMock.mock.calls[0][0].emailAndPassword.requireEmailVerification).toBe(false);
    });

    it('requires one when the operator turns the gate on', () => {
      createAuth({ db: {} as never, requireEmailVerification: true });

      expect(betterAuthMock.mock.calls[0][0].emailAndPassword.requireEmailVerification).toBe(true);
    });

    it('never lets better-auth mail the code on sign-up', () => {
      // Its sign-up hook also fires on the synthetic duplicate-email response, which
      // would mail a live code to an address whose owner never asked for it.
      createAuth({ db: {} as never });

      expect(betterAuthMock.mock.calls[0][0].emailVerification.sendOnSignUp).toBe(false);
      expect(betterAuthMock.mock.calls[0][0].emailVerification.autoSignInAfterVerification).toBe(
        true,
      );
    });
  });

  describe('cookie domain', () => {
    it('leaves the session cookie host-only by default', () => {
      createAuth({ db: {} as never });

      expect(betterAuthMock.mock.calls[0][0].advanced.crossSubDomainCookies).toBeUndefined();
    });

    it('widens the session cookie to the domain passed in options', () => {
      createAuth({ db: {} as never, cookieDomain: '.example.com' });

      expect(betterAuthMock.mock.calls[0][0].advanced.crossSubDomainCookies).toEqual({
        enabled: true,
        domain: '.example.com',
      });
    });

    it('falls back to AUTH_COOKIE_DOMAIN when no option is passed', () => {
      vi.stubEnv('AUTH_COOKIE_DOMAIN', '.env-example.com');

      createAuth({ db: {} as never });

      expect(betterAuthMock.mock.calls[0][0].advanced.crossSubDomainCookies).toEqual({
        enabled: true,
        domain: '.env-example.com',
      });
      vi.unstubAllEnvs();
    });
  });
});

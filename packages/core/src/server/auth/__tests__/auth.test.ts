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
    it('sends an email when type is forget-password', async () => {
      const sendEmail = vi.fn().mockResolvedValue(undefined);
      const templateRenderer = {
        render: vi.fn().mockResolvedValue({ subject: 'Reset', body: 'Code: 123456' }),
      };
      const getUserLanguage = vi.fn().mockResolvedValue('pl');

      createAuth({
        db: {} as never,
        sendEmail,
        templateRenderer,
        getUserLanguage,
      });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      await emailOtpOpts.sendVerificationOTP({
        email: 'test@example.com',
        otp: '123456',
        type: 'forget-password',
      });

      expect(getUserLanguage).toHaveBeenCalledWith('test@example.com');
      expect(templateRenderer.render).toHaveBeenCalledWith(
        'resetPasswordOtp',
        { otp: '123456', email: 'test@example.com' },
        'pl',
      );
      expect(sendEmail).toHaveBeenCalledWith({
        to: 'test@example.com',
        subject: 'Reset',
        body: 'Code: 123456',
      });
    });

    it('renders the existing-account template when the reset came from a sign-up', async () => {
      // better-auth issues both through the same `forget-password` type, so without the
      // predicate a duplicate sign-up mails a bare "Reset your password" to someone who
      // never asked to reset anything.
      const sendEmail = vi.fn().mockResolvedValue(undefined);
      const templateRenderer = {
        render: vi.fn().mockResolvedValue({ subject: 'Exists', body: 'Code: 123456' }),
      };

      createAuth({
        db: {} as never,
        sendEmail,
        templateRenderer,
        isExistingAccountSignUp: (email) => email === 'test@example.com',
      });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      await emailOtpOpts.sendVerificationOTP({
        email: 'test@example.com',
        otp: '123456',
        type: 'forget-password',
      });

      expect(templateRenderer.render).toHaveBeenCalledWith(
        'existingAccountSignUp',
        { otp: '123456', email: 'test@example.com' },
        'en',
      );
    });

    it('renders the verification code template for an email-verification OTP', async () => {
      const sendEmail = vi.fn().mockResolvedValue(undefined);
      const templateRenderer = {
        render: vi.fn().mockResolvedValue({ subject: 'Verify your email', body: 'code' }),
      };

      createAuth({ db: {} as never, sendEmail, templateRenderer });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      await emailOtpOpts.sendVerificationOTP({
        email: 'test@example.com',
        otp: '123456',
        type: 'email-verification',
      });

      expect(templateRenderer.render).toHaveBeenCalledWith('verifyEmail', { otp: '123456' }, 'en');
      expect(sendEmail).toHaveBeenCalledWith({
        to: 'test@example.com',
        subject: 'Verify your email',
        body: 'code',
      });
    });

    it('returns early without sending an email for other types', async () => {
      const sendEmail = vi.fn().mockResolvedValue(undefined);
      const templateRenderer = {
        render: vi.fn(),
      };
      const getUserLanguage = vi.fn();

      createAuth({
        db: {} as never,
        sendEmail,
        templateRenderer,
        getUserLanguage,
      });

      const emailOtpOpts = emailOTPMock.mock.calls[0][0];
      await emailOtpOpts.sendVerificationOTP({
        email: 'test@example.com',
        otp: '123456',
        type: 'sign-in',
      });

      expect(getUserLanguage).not.toHaveBeenCalled();
      expect(templateRenderer.render).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
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

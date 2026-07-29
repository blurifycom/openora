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
        { otp: '123456' },
        'pl',
      );
      expect(sendEmail).toHaveBeenCalledWith({
        to: 'test@example.com',
        subject: 'Reset',
        body: 'Code: 123456',
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
        type: 'verify-email',
      });

      expect(getUserLanguage).not.toHaveBeenCalled();
      expect(templateRenderer.render).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
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

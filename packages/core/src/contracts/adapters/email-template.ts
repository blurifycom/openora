import { createToken, type Token } from './token.js';

export type EmailTemplateKey =
  | 'verifyEmail'
  | 'resetPasswordOtp'
  | 'rgLimitUpdated'
  | 'rgCoolingOffActivated'
  | 'rgCoolingOffLifted'
  | 'rgSelfExclusionActivated'
  | 'rgSelfExclusionLifted';

export type EmailTemplateData = {
  verifyEmail: { otp: string };
  resetPasswordOtp: { otp: string; email: string };
  rgLimitUpdated: { period: string; type: string; description: string };
  rgCoolingOffActivated: { expiresAt: Date };
  rgCoolingOffLifted: Record<string, never>;
  rgSelfExclusionActivated: { expiresAt: Date | null; isPermanent: boolean };
  rgSelfExclusionLifted: Record<string, never>;
};

const formatEmailDate = (value: Date | null): string =>
  value === null
    ? 'further notice'
    : `${new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(value)} UTC`;

export type EmailTemplateRenderer = {
  render<K extends EmailTemplateKey>(
    key: K,
    data: EmailTemplateData[K],
    locale: string,
  ): Promise<{ subject: string; body: string }> | { subject: string; body: string };
};

export const EMAIL_TEMPLATE_RENDERER: Token<EmailTemplateRenderer> =
  createToken<EmailTemplateRenderer>('EMAIL_TEMPLATE_RENDERER');

/**
 * Production-safe English-only copy, shared by `DefaultEmailTemplateRenderer`
 * (packages/core/src/pam/identity/adapters/) and the SessionResolver-only createAuth()
 * fallback in server/auth/auth.ts - single source of truth so the two never drift.
 * Openora core intentionally ships English-only; overlays that need other languages
 * replace the renderer via ctx.provide(EMAIL_TEMPLATE_RENDERER, () => new MyRenderer()) -
 * `render`'s `locale` param (sourced from IdentityService.resolveUserLanguage) exists for exactly that seam.
 */
export const DEFAULT_EMAIL_TEMPLATES: {
  [K in EmailTemplateKey]: (data: EmailTemplateData[K]) => { subject: string; body: string };
} = {
  verifyEmail: (data) => ({
    subject: 'Verify your email',
    body: `Your email verification code is: ${data.otp}`,
  }),
  resetPasswordOtp: (data) => ({
    subject: 'Reset your password',
    body: `Your password reset code is: ${data.otp}`,
  }),
  rgLimitUpdated: (data) => ({
    subject: 'Your gambling limit was updated',
    body: `A ${data.period} ${data.type} limit of ${data.description} is now active on your account.`,
  }),
  rgCoolingOffActivated: (data) => ({
    subject: 'Your cooling-off period has started',
    body: `A cooling-off period is active on your account until ${formatEmailDate(data.expiresAt)}.\n\nYou will not be able to log in or place bets until then.`,
  }),
  rgCoolingOffLifted: () => ({
    subject: 'Your cooling-off period has ended',
    body: 'Your cooling-off period has been ended and you can log in again.',
  }),
  rgSelfExclusionActivated: (data) => ({
    subject: 'Your self-exclusion has started',
    body: data.isPermanent
      ? 'Your account has been permanently self-excluded and you will not be able to log in.'
      : `Your account is self-excluded until ${formatEmailDate(data.expiresAt)}.\n\nYou will not be able to log in until then.`,
  }),
  rgSelfExclusionLifted: () => ({
    subject: 'Your self-exclusion has been lifted',
    body: 'Your self-exclusion has been lifted and you can log in again.',
  }),
};

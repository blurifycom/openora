import { createToken, type Token } from './token.js';

export type EmailTemplateKey = 'verifyEmail' | 'resetPasswordOtp';

export type EmailTemplateData = {
  verifyEmail: { url: string; token: string };
  resetPasswordOtp: { otp: string };
};

export type EmailTemplateRenderer = {
  render<K extends EmailTemplateKey>(
    key: K,
    data: EmailTemplateData[K],
    locale: string,
  ): Promise<{ subject: string; body: string }> | { subject: string; body: string };
};

export const EMAIL_TEMPLATE_RENDERER: Token<EmailTemplateRenderer> =
  createToken<EmailTemplateRenderer>('EMAIL_TEMPLATE_RENDERER');

// Production-safe English-only copy, shared by `DefaultEmailTemplateRenderer`
// (packages/core/src/pam/identity/adapters/) and the SessionResolver-only createAuth()
// fallback in server/auth/auth.ts - single source of truth so the two never drift.
// Openora core intentionally ships English-only; overlays that need other languages
// replace the renderer via ctx.provide(EMAIL_TEMPLATE_RENDERER, () => new MyRenderer()) -
// `render`'s `locale` param (sourced from IdentityService.resolveUserLanguage) exists for exactly that seam.
export const DEFAULT_EMAIL_TEMPLATES: {
  [K in EmailTemplateKey]: (data: EmailTemplateData[K]) => { subject: string; body: string };
} = {
  verifyEmail: (data) => ({
    subject: 'Verify your email',
    body: `Verify your email using this link: ${data.url}\n\nVerification token: ${data.token}`,
  }),
  resetPasswordOtp: (data) => ({
    subject: 'Reset your password',
    body: `Your password reset code is: ${data.otp}`,
  }),
};

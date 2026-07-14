import { createToken, type Token } from './token.js';

export type EmailTemplateKey = 'verifyEmail' | 'resetPasswordOtp';

export type EmailTemplateRenderer = {
  render(
    key: EmailTemplateKey,
    data: Record<string, string>,
    locale: string,
  ): Promise<{ subject: string; body: string }> | { subject: string; body: string };
};

export const EMAIL_TEMPLATE_RENDERER: Token<EmailTemplateRenderer> =
  createToken<EmailTemplateRenderer>('EMAIL_TEMPLATE_RENDERER');

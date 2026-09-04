import { createToken, type Token } from './token.js';
import type { MailTemplate } from '../schemas/mail.js';

export type RenderedEmail = { subject: string; html: string; text: string };

export type EmailTemplateRenderer = {
  render(
    template: MailTemplate,
    locale: string,
    recipientName?: string | null,
  ): Promise<RenderedEmail> | RenderedEmail;
};

export const EMAIL_TEMPLATE_RENDERER: Token<EmailTemplateRenderer> =
  createToken<EmailTemplateRenderer>('EMAIL_TEMPLATE_RENDERER');

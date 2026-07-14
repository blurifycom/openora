// Production-safe default (English-only, unlike the dev-only Mock* adapters).
// Replace via overlay: ctx.provide(EMAIL_TEMPLATE_RENDERER, () => new MyRenderer())
import type { EmailTemplateKey, EmailTemplateRenderer } from '@openora/core/contracts';

export class DefaultEmailTemplateRenderer implements EmailTemplateRenderer {
  render(
    key: EmailTemplateKey,
    data: Record<string, string>,
    _locale: string,
  ): { subject: string; body: string } {
    switch (key) {
      case 'verifyEmail':
        return {
          subject: 'Verify your email',
          body: `Verify your email using this link: ${data['url']}\n\nVerification token: ${data['token']}`,
        };
      case 'resetPasswordOtp':
        return {
          subject: 'Reset your password',
          body: `Your password reset code is: ${data['otp']}`,
        };
    }
  }
}

// Production-safe default (English-only, unlike the dev-only Mock* adapters).
// Replace via overlay: ctx.provide(EMAIL_TEMPLATE_RENDERER, () => new MyRenderer())
import {
  DEFAULT_EMAIL_TEMPLATES,
  type EmailTemplateData,
  type EmailTemplateKey,
  type EmailTemplateRenderer,
} from '@openora/core/contracts';

export class DefaultEmailTemplateRenderer implements EmailTemplateRenderer {
  render<K extends EmailTemplateKey>(
    key: K,
    data: EmailTemplateData[K],
    _locale: string,
  ): { subject: string; body: string } {
    return DEFAULT_EMAIL_TEMPLATES[key](data);
  }
}

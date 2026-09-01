import {
  renderDefaultEmail,
  type EmailTemplateRenderer,
  type MailTemplate,
  type RenderedEmail,
} from '@openora/core/contracts';

/**
 * Platform-default `EMAIL_TEMPLATE_RENDERER` binding: English-only plain text for
 * every template key, with a minimal generated HTML body. An operator overlay
 * rebinds `EMAIL_TEMPLATE_RENDERER` for other languages and a designed HTML body.
 * `locale` still reaches `renderDefaultEmail` so dates/numbers follow the
 * recipient even without an overlay.
 */
export class DefaultEmailTemplateRenderer implements EmailTemplateRenderer {
  render(template: MailTemplate, locale: string): RenderedEmail {
    return renderDefaultEmail(template, locale);
  }
}

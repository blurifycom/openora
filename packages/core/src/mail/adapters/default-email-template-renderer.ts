import {
  renderDefaultEmail,
  type EmailTemplateRenderer,
  type MailTemplate,
  type RenderedEmail,
} from '@openora/core/contracts';

/** Platform-default `EMAIL_TEMPLATE_RENDERER`: English-only plain text, minimal HTML. */
export class DefaultEmailTemplateRenderer implements EmailTemplateRenderer {
  render(template: MailTemplate, locale: string, _recipientName?: string | null): RenderedEmail {
    return renderDefaultEmail(template, locale);
  }
}

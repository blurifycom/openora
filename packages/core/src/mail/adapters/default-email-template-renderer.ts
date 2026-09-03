import {
  renderDefaultEmail,
  type EmailTemplateRenderer,
  type MailTemplate,
  type RenderedEmail,
} from '@openora/core/contracts';

export class DefaultEmailTemplateRenderer implements EmailTemplateRenderer {
  render(template: MailTemplate, locale: string, _recipientName?: string | null): RenderedEmail {
    return renderDefaultEmail(template, locale);
  }
}

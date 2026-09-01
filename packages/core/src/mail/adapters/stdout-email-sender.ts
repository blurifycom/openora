import { createLogger } from '@openora/core/server';
import type { EmailMessage, EmailSenderPort } from '@openora/core/contracts';

const logger = createLogger('mail');

/**
 * Platform-default `EMAIL_SENDER`: logs the message metadata to stdout instead of
 * sending. Safe for dev/stage/test. An operator overlay rebinds `EMAIL_SENDER`
 * to a real provider (SMTP, SES, Postmark) after the mail plugin.
 */
export class StdoutEmailSender implements EmailSenderPort {
  async send(message: EmailMessage): Promise<void> {
    logger.info(
      { to: message.to, subject: message.subject, bytes: message.html.length },
      'mock email delivery (no EMAIL_SENDER overlay bound)',
    );
  }
}

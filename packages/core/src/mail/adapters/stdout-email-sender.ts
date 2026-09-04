import { createLogger } from '@openora/core/server';
import type { EmailMessage, EmailSenderPort } from '@openora/core/contracts';

const logger = createLogger('mail');

export class StdoutEmailSender implements EmailSenderPort {
  async send(message: EmailMessage): Promise<void> {
    logger.info(
      { to: message.to, subject: message.subject, bytes: message.html.length },
      'mock email delivery (no EMAIL_SENDER overlay bound)',
    );
  }
}

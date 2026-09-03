import { createLogger } from '@openora/core/server';
import type { EmailMessage, EmailSenderPort } from '@openora/core/contracts';

const logger = createLogger('mail');

/** Platform-default `EMAIL_SENDER`: logs the message metadata, never sends. */
export class StdoutEmailSender implements EmailSenderPort {
  async send(message: EmailMessage): Promise<void> {
    // mock: no real transport until an operator overlay rebinds EMAIL_SENDER
    logger.info(
      { to: message.to, subject: message.subject, bytes: message.html.length },
      'mock email delivery (no EMAIL_SENDER overlay bound)',
    );
  }
}

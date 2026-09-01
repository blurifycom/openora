/**
 * Mail seams, owned by the `mail` module.
 *
 * `EMAIL_SENDER` is the transport: it takes a fully rendered message with HTML
 * and plain text as separate fields. It replaces the old `SEND_EMAIL` and
 * `NOTIFICATION_DELIVERY_ADAPTER` - one binding, one argument shape. The default
 * binding logs to stdout; an operator overlay rebinds it to a real provider.
 *
 * `MAIL_DISPATCH` is the façade every caller uses. It never sends inline: each
 * call enqueues onto the `mail-send` job queue, so rendering and transport stay
 * off the request path and inherit the queue's retry, concurrency cap and
 * idempotency. `toUser` resolves the address and locale from the user directory;
 * `toAddress` is for callers that only hold an address (the auth OTP hook, an
 * admin invitation) and must not confirm whether an account exists.
 *
 * See docs/adapters/mail.md and ADR-0036.
 */
import { createToken, type Token } from './token.js';
import type { MailTemplate } from '../schemas/mail.js';

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type EmailSenderPort = {
  send(message: EmailMessage): Promise<void>;
};

// Generator-friendly alias: adapter scaffolds derive their port type from the token name.
export type EmailSender = EmailSenderPort;

export const EMAIL_SENDER: Token<EmailSenderPort> = createToken<EmailSenderPort>('EMAIL_SENDER');

export type MailToUserInput = {
  userId: string;
  template: MailTemplate;
  /** Stable key -> at most one send per logical trigger (eg an RG exclusion row id). */
  idempotencyKey: string;
};

export type MailToAddressInput = {
  email: string;
  /** Recipient locale; when omitted the mail module falls back to `'en'`. */
  locale?: string;
  template: MailTemplate;
  idempotencyKey: string;
};

export type MailDispatchPort = {
  toUser(input: MailToUserInput): Promise<void>;
  toAddress(input: MailToAddressInput): Promise<void>;
};

export const MAIL_DISPATCH: Token<MailDispatchPort> =
  createToken<MailDispatchPort>('MAIL_DISPATCH');

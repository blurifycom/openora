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

export type EmailSender = EmailSenderPort;

export const EMAIL_SENDER: Token<EmailSenderPort> = createToken<EmailSenderPort>('EMAIL_SENDER');

export type MailToUserInput = {
  userId: string;
  template: MailTemplate;
  idempotencyKey: string;
};

export type MailToAddressInput = {
  email: string;
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

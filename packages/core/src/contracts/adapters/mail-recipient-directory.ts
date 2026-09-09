import type { User } from '../schemas/identity.js';
import { createToken, type Token } from './token.js';

/**
 * Mail-only recipient lookup. The anti-phishing code is deliberately available
 * through no broader directory port: only delivery needs to read it.
 */
export type MailRecipient = {
  email: string;
  language: string | null;
  name: string | null;
  antiPhishingCode: string | null;
};

export type MailRecipientDirectory = {
  getMailRecipient(userId: User['id']): Promise<MailRecipient | null>;
};

export const MAIL_RECIPIENT_DIRECTORY: Token<MailRecipientDirectory> = createToken(
  'MAIL_RECIPIENT_DIRECTORY',
);

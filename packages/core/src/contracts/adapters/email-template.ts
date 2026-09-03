import { createToken, type Token } from './token.js';
import { formatMoneyAmount } from '../schemas/common.js';
import type { EmailTemplateData, EmailTemplateKey, MailTemplate } from '../schemas/mail.js';

export type RenderedEmail = { subject: string; html: string; text: string };

/**
 * Renders one `{ key, data }` template into a subject + HTML + text for a locale.
 * `recipientName` is the account display name for a `toUser` send, or `null` for a
 * `toAddress` send (OTP, invitation - no account behind the address). The default
 * renderer ignores it; an operator overlay uses it for a greeting.
 */
export type EmailTemplateRenderer = {
  render(
    template: MailTemplate,
    locale: string,
    recipientName?: string | null,
  ): Promise<RenderedEmail> | RenderedEmail;
};

export const EMAIL_TEMPLATE_RENDERER: Token<EmailTemplateRenderer> =
  createToken<EmailTemplateRenderer>('EMAIL_TEMPLATE_RENDERER');

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const textToHtml = (text: string): string =>
  text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

const formatEmailDate = (iso: string | null, locale: string): string =>
  iso === null
    ? 'further notice'
    : `${new Intl.DateTimeFormat(locale, {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(iso))} UTC`;

const formatMoney = (amount: string, currency: string): string =>
  `${formatMoneyAmount(amount)} ${currency}`;

type PlainTemplate<K extends EmailTemplateKey> = (
  data: EmailTemplateData[K],
  locale: string,
) => { subject: string; text: string };

/** English-only fallback copy for every template key. An operator overlay replaces it. */
const PLAIN_EMAIL_TEMPLATES: { [K in EmailTemplateKey]: PlainTemplate<K> } = {
  verifyEmail: (data) => ({
    subject: 'Verify your email',
    text: `Your email verification code is: ${data.otp}`,
  }),
  resetPasswordOtp: (data) => ({
    subject: 'Reset your password',
    text: `Your password reset code is: ${data.otp}`,
  }),
  adminResetPasswordOtp: (data) => ({
    subject: 'Password reset requested by an administrator',
    text: `An administrator requested a password reset for your account. Your reset code is: ${data.otp}`,
  }),
  // Must never confirm or deny the account exists to anyone but its owner - the copy
  // addresses the owner and the sign-up response is identical either way.
  existingAccountSignUp: (data) => ({
    subject: 'You already have an account',
    text:
      `Someone tried to create an account with this email address. ` +
      `You already have one, so no new account was created. ` +
      `If it was you, sign in as usual - or use this code to reset your password: ${data.otp}`,
  }),
  rgLimitUpdated: (data) => ({
    subject: 'Your gambling limit was updated',
    text: `A ${data.period} ${data.type} limit of ${data.description} is now active on your account.`,
  }),
  rgCoolingOffActivated: (data, locale) => ({
    subject: 'Your cooling-off period has started',
    text: `A cooling-off period is active on your account until ${formatEmailDate(
      data.expiresAt,
      locale,
    )}.\n\nYou will not be able to log in or place bets until then.`,
  }),
  rgCoolingOffLifted: () => ({
    subject: 'Your cooling-off period has ended',
    text: 'Your cooling-off period has been ended and you can log in again.',
  }),
  rgSelfExclusionActivated: (data, locale) => ({
    subject: 'Your self-exclusion has started',
    text: data.isPermanent
      ? 'Your account has been permanently self-excluded and you will not be able to log in.'
      : `Your account is self-excluded until ${formatEmailDate(
          data.expiresAt,
          locale,
        )}.\n\nYou will not be able to log in until then.`,
  }),
  rgSelfExclusionLifted: () => ({
    subject: 'Your self-exclusion has been lifted',
    text: 'Your self-exclusion has been lifted and you can log in again.',
  }),
  withdrawalApproved: (data, locale) => ({
    subject: 'Your withdrawal was approved',
    text:
      `Your withdrawal of ${formatMoney(data.amount, data.currency)} has been approved and is being processed.\n\n` +
      `Transaction: ${data.transactionId}\nDate: ${formatEmailDate(data.occurredAt, locale)}`,
  }),
  withdrawalRejected: (data, locale) => ({
    subject: 'Your withdrawal was rejected',
    text:
      `Your withdrawal of ${formatMoney(data.amount, data.currency)} was rejected and the funds were returned to your balance.\n\n` +
      `Transaction: ${data.transactionId}\nDate: ${formatEmailDate(data.occurredAt, locale)}` +
      (data.reason ? `\nReason: ${data.reason}` : ''),
  }),
  kycResubmissionRequested: (data) => ({
    subject: 'Document resubmission required',
    text:
      `An admin has requested you resubmit your verification documents.` +
      (data.reason ? ` Reason: ${data.reason}.` : ''),
  }),
  adminInvitation: (data, locale) => ({
    subject: 'You have been invited as an administrator',
    text: `Your admin invitation token: ${data.token}. It expires at ${formatEmailDate(
      data.expiresAt,
      locale,
    )}.`,
  }),
};

/** English-only fallback render for one `{ key, data }` template. */
export function renderDefaultEmail(template: MailTemplate, locale: string): RenderedEmail {
  // Sanctioned variance cast (see conventions): indexing the map by a union key gives a
  // union of functions TS won't call with the union data; MailTemplateSchema guards the pairing.
  const plain = PLAIN_EMAIL_TEMPLATES[template.key] as PlainTemplate<typeof template.key>;
  const { subject, text } = plain(template.data, locale);
  return { subject, text, html: textToHtml(text) };
}

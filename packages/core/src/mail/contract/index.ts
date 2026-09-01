import * as z from 'zod';
import { MailTemplateSchema, UuidSchema, queue } from '@openora/core/contracts';

/**
 * The `mail` module has no HTTP surface - it owns the outbound-mail seams and one
 * background queue. This "contract" is the wire shape of that queue's payload,
 * validated before the worker handler runs (deliveries cross the queue, so a
 * `Date` in the template data would not survive - datetimes are ISO strings).
 */
export const MAIL_SEND_QUEUE = queue('mail-send');

export const MailRecipientSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: UuidSchema }),
  z.object({ kind: z.literal('address'), email: z.email(), locale: z.string().optional() }),
]);
export type MailRecipient = z.infer<typeof MailRecipientSchema>;

export const MailSendJobSchema = z.object({
  recipient: MailRecipientSchema,
  template: MailTemplateSchema,
});
export type MailSendJob = z.infer<typeof MailSendJobSchema>;

// Mail can carry password-reset OTPs and invitation tokens. The queue persists this
// envelope, never the plaintext recipient or template payload.
export const EncryptedMailSendJobSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
});
export type EncryptedMailSendJob = z.infer<typeof EncryptedMailSendJobSchema>;

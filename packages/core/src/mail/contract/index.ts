import * as z from 'zod';
import { MailTemplateSchema, UuidSchema, queue } from '@openora/core/contracts';

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

export const EncryptedMailSendJobSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
});
export type EncryptedMailSendJob = z.infer<typeof EncryptedMailSendJobSchema>;

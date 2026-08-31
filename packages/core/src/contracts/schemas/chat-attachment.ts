import * as z from 'zod';

export const CHAT_ATTACHMENT_KINDS = ['gif'] as const;
export const ChatAttachmentKindSchema = z.enum(CHAT_ATTACHMENT_KINDS);
export type ChatAttachmentKind = z.infer<typeof ChatAttachmentKindSchema>;

export const ChatAttachmentSchema = z.object({
  kind: ChatAttachmentKindSchema,
  provider: z.string().trim().min(1).max(32),
  externalId: z.string().trim().min(1).max(128),
  url: z.url().max(2048),
  previewUrl: z.url().max(2048),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  title: z.string().trim().max(200),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

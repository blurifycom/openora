import * as z from 'zod';
import { TimestampSchema } from '../schemas/common.js';
import { createToken, type Token } from './token.js';

export const SUPPORT_TICKET_STATUSES = ['open', 'waiting', 'on_hold', 'solved', 'closed'] as const;
export const SUPPORT_CHAT_STATUSES = ['active', 'ended'] as const;

export const SupportHistoryItemSchema = z
  .object({
    kind: z.enum(['ticket', 'chat']),
    id: z.string().min(1),
    reference: z.string().min(1),
    subject: z.string().nullable(),
    status: z.enum([...SUPPORT_TICKET_STATUSES, ...SUPPORT_CHAT_STATUSES]),
    assignee: z.string().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    url: z.url({ protocol: /^https$/ }).regex(/^https:\/\//i),
  })
  .strict();
export type SupportHistoryItem = z.infer<typeof SupportHistoryItemSchema>;

export const SupportHistoryEmailWindowSchema = z.object({
  email: z.string(),
  from: TimestampSchema,
  to: TimestampSchema.nullable(),
});
export type SupportHistoryEmailWindow = z.infer<typeof SupportHistoryEmailWindowSchema>;

export const SupportHistorySchema = z.object({
  tickets: z.object({
    state: z.enum(['ok', 'unavailable', 'no_email', 'email_gap']),
    items: z.array(SupportHistoryItemSchema),
    complete: z.boolean(),
  }),
  chats: z.object({
    state: z.enum(['ok', 'unavailable', 'not_linked']),
    items: z.array(SupportHistoryItemSchema),
  }),
  fetchedAt: TimestampSchema,
});
export type SupportHistory = z.infer<typeof SupportHistorySchema>;

export type SupportHistoryReader = {
  listTickets(input: {
    windows: SupportHistoryEmailWindow[];
    includeResolved: boolean;
  }): Promise<SupportHistoryItem[]>;
  listChats(input: { customerId: string }): Promise<SupportHistoryItem[]>;
};

export const SUPPORT_HISTORY_READER: Token<SupportHistoryReader> =
  createToken<SupportHistoryReader>('SUPPORT_HISTORY_READER');

export const SUPPORT_HISTORY_FAILURE_REASONS = [
  'unauthorized',
  'rate_limited',
  'timeout',
  'unavailable',
  'not_found',
  'bad_response',
] as const;
export const SupportHistoryFailureReasonSchema = z.enum(SUPPORT_HISTORY_FAILURE_REASONS);
export type SupportHistoryFailureReason = z.infer<typeof SupportHistoryFailureReasonSchema>;

export class SupportHistoryProviderError extends Error {
  readonly reason: SupportHistoryFailureReason;

  constructor(reason: SupportHistoryFailureReason, options?: ErrorOptions) {
    super(`support-history provider failed: ${reason}`, options);
    this.name = 'SupportHistoryProviderError';
    this.reason = reason;
  }
}

/**
 * Bind a concrete `SupportHistoryReader` to `SUPPORT_HISTORY_READER` in an overlay; core never
 * binds one. A separate token from `SUPPORT_CHAT_PROVIDER`: an operator may bind either without
 * the other. Timestamps the adapter answers are UTC ISO strings ending in `Z`, and item links are
 * https URLs; anything else fails validation. See docs/adapters/support-chat.md for the binding guide.
 */
import * as z from 'zod';
import { TimestampSchema } from '../schemas/common.js';
import { createToken, type Token } from './token.js';

export const SUPPORT_TICKET_STATUSES = ['open', 'waiting', 'on_hold', 'solved', 'closed'] as const;
export const SUPPORT_CHAT_STATUSES = ['active', 'ended'] as const;

/**
 * One vendor ticket or one chat thread, a ticket with a ticket status and a chat with a chat
 * status. Core validates the adapter's answer against this schema and those per-kind statuses,
 * and treats anything else as unavailable.
 */
export const SupportHistoryItemSchema = z
  .object({
    kind: z.enum(['ticket', 'chat']),
    // The vendor id the link uses (ticket id, chat thread id).
    id: z.string().min(1),
    // The short id staff quote to each other.
    reference: z.string().min(1),
    // The ticket subject; null for a chat.
    subject: z.string().nullable(),
    status: z.enum([...SUPPORT_TICKET_STATUSES, ...SUPPORT_CHAT_STATUSES]),
    // The staff display name, null when unassigned.
    assignee: z.string().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    // Opens the item in the vendor's agent app; https only, so a link can never run script.
    url: z.url({ protocol: /^https$/ }),
  })
  .strict();
export type SupportHistoryItem = z.infer<typeof SupportHistoryItemSchema>;

/**
 * An email the player held, from when it became theirs (registration or a change) to when it
 * stopped being theirs; `to` is null for the current email. A freed address can be registered by
 * another player, so only tickets created inside the window belong to this one.
 */
export const SupportHistoryEmailWindowSchema = z.object({
  email: z.string(),
  from: TimestampSchema,
  to: TimestampSchema.nullable(),
});
export type SupportHistoryEmailWindow = z.infer<typeof SupportHistoryEmailWindowSchema>;

/** A player's support history as the back office reads it; each section fails on its own. */
export const SupportHistorySchema = z.object({
  tickets: z.object({
    state: z.enum(['ok', 'unavailable', 'no_email']),
    items: z.array(SupportHistoryItemSchema),
  }),
  chats: z.object({
    state: z.enum(['ok', 'unavailable', 'not_linked']),
    items: z.array(SupportHistoryItemSchema),
  }),
  fetchedAt: TimestampSchema,
});
export type SupportHistory = z.infer<typeof SupportHistorySchema>;

export type SupportHistoryReader = {
  /**
   * Tickets whose requester is one of `windows[].email`, created inside that email's window.
   * `includeResolved: false` must not spend the vendor's resolved-archive calls.
   */
  listTickets(input: {
    windows: SupportHistoryEmailWindow[];
    includeResolved: boolean;
  }): Promise<SupportHistoryItem[]>;
  /** Chat threads of one vendor customer, active and ended: one item per thread. */
  listChats(input: { customerId: string }): Promise<SupportHistoryItem[]>;
};

export const SUPPORT_HISTORY_READER: Token<SupportHistoryReader> =
  createToken<SupportHistoryReader>('SUPPORT_HISTORY_READER');

/**
 * Thrown by an adapter when the vendor refuses, is unreachable or answers something unexpected.
 * `reason` is short and goes to the log only, never to the response: no token, no request body,
 * no unmasked email.
 */
export class SupportHistoryProviderError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super(`support-history provider failed: ${reason}`, options);
    this.name = 'SupportHistoryProviderError';
    this.reason = reason;
  }
}

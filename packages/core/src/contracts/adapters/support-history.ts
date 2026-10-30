/**
 * Bind a concrete `SupportHistoryReader` to `SUPPORT_HISTORY_READER` in an overlay; core never
 * binds one. A separate token from `SUPPORT_CHAT_PROVIDER`: an operator may bind either without
 * the other. Timestamps the adapter answers are UTC ISO strings ending in `Z`, and item links are
 * absolute `https://` URLs; anything else fails validation. See docs/adapters/support-chat.md for
 * the binding guide.
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
    // Opens the item in the vendor's agent app: an absolute https URL only, so a link can never
    // run script or resolve against the back office's own origin (`https:../x`).
    url: z.url({ protocol: /^https$/ }).regex(/^https:\/\//i),
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

/**
 * A player's support history as the back office reads it; each section fails on its own.
 * `tickets.complete` is true only when every email the player held was searched: an early break
 * in the email-change trail, or the cap on previous emails, leaves the older ones out.
 */
export const SupportHistorySchema = z.object({
  tickets: z.object({
    state: z.enum(['ok', 'unavailable', 'no_email']),
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
  /**
   * Tickets whose requester is one of `windows[].email`, created inside that email's window.
   * Core passes only the windows it trusts, which may cover fewer than all the player's emails.
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
 * Why a support-history read failed: the vendor refused the credentials (`unauthorized`), throttled
 * the call (`rate_limited`), did not answer in time (`timeout`), was down or unreachable
 * (`unavailable`), did not know the customer or requester (`not_found`), or answered something
 * unexpected (`bad_response`). A fixed set, so no free text an adapter writes reaches the log.
 */
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

/**
 * Thrown by an adapter when the vendor refuses, is unreachable or answers something unexpected.
 * `reason` is one of `SUPPORT_HISTORY_FAILURE_REASONS` and goes to the log only, never to the
 * response; core logs any other value, which a JavaScript adapter can still pass, as
 * `unlisted reason`.
 */
export class SupportHistoryProviderError extends Error {
  readonly reason: SupportHistoryFailureReason;

  constructor(reason: SupportHistoryFailureReason, options?: ErrorOptions) {
    super(`support-history provider failed: ${reason}`, options);
    this.name = 'SupportHistoryProviderError';
    this.reason = reason;
  }
}

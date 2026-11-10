/**
 * Bind a concrete `SupportChatProvider` to `SUPPORT_CHAT_PROVIDER` in an overlay; core never
 * binds one. The vendor runs the live-chat widget; core owns which vendor customer a player is
 * and what support staff see about them. See docs/adapters/support-chat.md for the binding guide.
 */
import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '../schemas/common.js';
import { KycStatusSchema, PlayerStatusSchema } from '../schemas/player.js';
import type { SupportHistoryFailureReason } from './support-history.js';
import { createToken, type Token } from './token.js';

/**
 * What the player's browser uses to open the chat as that vendor customer. `expiresInMs` is
 * the token's lifetime from now. Core validates the vendor's answer against this schema and
 * refuses as unavailable on anything else.
 */
export const SupportChatCustomerTokenSchema = z.object({
  customerId: z.string().min(1),
  accessToken: z.string().min(1),
  tokenType: z.string().min(1),
  expiresInMs: z.number().int().positive(),
});
export type SupportChatCustomerToken = z.infer<typeof SupportChatCustomerTokenSchema>;

/**
 * What support staff see next to the chat, read when `syncedAt` says. `accountStatus` folds an
 * active self-exclusion in as `self_excluded`, except that `suspended` and `closed` keep their
 * own status; `isSelfExcluded` is true whenever one is active. Strict on purpose: it leaves the
 * platform for a third party, so a field is added here deliberately or not at all - never a
 * balance, a document, a phone number or a date of birth.
 */
export const SupportCustomerContextSchema = z
  .object({
    playerId: UuidSchema,
    userId: UuidSchema,
    username: z.string(),
    email: z.string(),
    accountStatus: PlayerStatusSchema,
    isSelfExcluded: z.boolean(),
    isCoolingOff: z.boolean(),
    kycStatus: KycStatusSchema,
    rankName: z.string().nullable(),
    accountManagerName: z.string().nullable(),
    activeCurrency: z.string(),
    syncedAt: TimestampSchema,
  })
  .strict();
export type SupportCustomerContext = z.infer<typeof SupportCustomerContextSchema>;

/** An offline ticket a player writes to support, outside a live chat. */
export type SupportTicketRequest = {
  requester: { name: string; email: string };
  language: string;
  message: string;
};

export type SupportChatProvider = {
  /**
   * Without `customerId` the vendor creates a new chat customer; with it, a token for that
   * existing customer, which must never be answered with another customer's token.
   */
  issueCustomerToken(input: { customerId?: string }): Promise<SupportChatCustomerToken>;

  /**
   * Writes `context` and the customer's display name and email onto the vendor customer. The
   * vendor's field names and types are the adapter's. Must be safe to repeat: a retried or
   * reordered sync writes the same values again.
   */
  syncCustomer(customerId: string, context: SupportCustomerContext): Promise<void>;

  /**
   * Creates exactly one ticket authored by the customer, with `requester` as given as its
   * requester and in no group: routing it is the vendor's. Not idempotent - every call is a new
   * ticket, and core never retries one. On failure, throw `SupportChatProviderError` with a listed
   * reason. Mask the email in any log line. Optional: without it, the ticket route answers not
   * configured.
   */
  createTicket?(input: SupportTicketRequest): Promise<void>;
};

export const SUPPORT_CHAT_PROVIDER: Token<SupportChatProvider> =
  createToken<SupportChatProvider>('SUPPORT_CHAT_PROVIDER');

/**
 * Thrown by an adapter when the vendor refuses, is unreachable or answers something unexpected.
 * `reason` is one of `SUPPORT_HISTORY_FAILURE_REASONS` and goes to the log only, never to the
 * player; core logs any other value, which a JavaScript adapter can still pass, as
 * `unlisted reason`, and any other thrown value as `unexpected adapter error`. It may carry the
 * original error as `cause`; core never reads, logs, reports or rethrows it.
 */
export class SupportChatProviderError extends Error {
  readonly reason: SupportHistoryFailureReason;

  constructor(reason: SupportHistoryFailureReason, options?: ErrorOptions) {
    super(`support-chat provider failed: ${reason}`, options);
    this.name = 'SupportChatProviderError';
    this.reason = reason;
  }
}

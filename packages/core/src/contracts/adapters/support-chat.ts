/**
 * Bind a concrete `SupportChatProvider` to `SUPPORT_CHAT_PROVIDER` in an overlay; core never
 * binds one. The vendor runs the live-chat widget; core owns which vendor customer a player is
 * and what support staff see about them. See docs/adapters/support-chat.md for the binding guide.
 */
import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '../schemas/common.js';
import { KycStatusSchema, PlayerStatusSchema } from '../schemas/player.js';
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
};

export const SUPPORT_CHAT_PROVIDER: Token<SupportChatProvider> =
  createToken<SupportChatProvider>('SUPPORT_CHAT_PROVIDER');

/**
 * Thrown by an adapter when the vendor refuses, is unreachable or answers something unexpected.
 * `reason` is short and goes to the log only, never to the player: no token, no request body,
 * no unmasked email.
 */
export class SupportChatProviderError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super(`support-chat provider failed: ${reason}`, options);
    this.name = 'SupportChatProviderError';
    this.reason = reason;
  }
}

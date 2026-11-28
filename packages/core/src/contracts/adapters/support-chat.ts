import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '../schemas/common.js';
import { KycStatusSchema, PlayerStatusSchema } from '../schemas/player.js';
import type { SupportHistoryFailureReason } from './support-history.js';
import { createToken, type Token } from './token.js';

export const SupportChatCustomerTokenSchema = z.object({
  customerId: z.string().min(1),
  accessToken: z.string().min(1),
  tokenType: z.string().min(1),
  expiresInMs: z.number().int().positive(),
});
export type SupportChatCustomerToken = z.infer<typeof SupportChatCustomerTokenSchema>;

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

export const SupportTicketCreatedSchema = z.object({
  ticketId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\w.:#/=+~-]+$/),
});
export type SupportTicketCreated = z.infer<typeof SupportTicketCreatedSchema>;

export type SupportTicketRequest = {
  requester: { name: string; email: string };
  language: string;
  subject: string;
  message: string;
};

export type SupportChatProvider = {
  issueCustomerToken(input: { customerId?: string }): Promise<SupportChatCustomerToken>;

  syncCustomer(customerId: string, context: SupportCustomerContext): Promise<void>;

  createTicket?(input: SupportTicketRequest): Promise<SupportTicketCreated>;
};

export const SUPPORT_CHAT_PROVIDER: Token<SupportChatProvider> =
  createToken<SupportChatProvider>('SUPPORT_CHAT_PROVIDER');

export class SupportChatProviderError extends Error {
  readonly reason: SupportHistoryFailureReason;

  constructor(reason: SupportHistoryFailureReason, options?: ErrorOptions) {
    super(`support-chat provider failed: ${reason}`, options);
    this.name = 'SupportChatProviderError';
    this.reason = reason;
  }
}

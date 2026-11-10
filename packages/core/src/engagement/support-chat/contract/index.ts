import * as z from 'zod';
import { oc } from '@orpc/contract';
import {
  QueryBooleanSchema,
  SupportChatCustomerTokenSchema,
  SupportHistorySchema,
  UuidSchema,
} from '@openora/core/contracts';

export const SUPPORT_TICKET_MESSAGE_MAX = 5000;

export const supportChatContract = {
  // Takes no input: always the caller's own player.
  session: oc
    .route({ method: 'POST', path: '/support-chat/session' })
    .output(SupportChatCustomerTokenSchema),

  // An offline ticket from the caller's own player. Requester name, email and language come from
  // the account, never from the body, so any other field is refused.
  createTicket: oc
    .route({ method: 'POST', path: '/support-chat/tickets' })
    .input(z.object({ message: z.string().trim().min(1).max(SUPPORT_TICKET_MESSAGE_MAX) }).strict())
    .output(z.object({ success: z.literal(true) })),

  // A player's vendor tickets and chat threads for the back office. Without `includeResolved`,
  // the vendor's resolved archive is not read.
  playerHistory: oc
    .route({ method: 'GET', path: '/support-chat/admin/players/{userId}/history' })
    .input(z.object({ userId: UuidSchema, includeResolved: QueryBooleanSchema.optional() }))
    .output(SupportHistorySchema),
};

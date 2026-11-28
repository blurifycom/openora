import * as z from 'zod';
import { oc } from '@orpc/contract';
import {
  QueryBooleanSchema,
  SupportChatCustomerTokenSchema,
  SupportHistorySchema,
  UuidSchema,
} from '@openora/core/contracts';

export const SUPPORT_TICKET_SUBJECT_MAX = 150;
export const SUPPORT_TICKET_MESSAGE_MAX = 5000;

const hasVisibleText = (text: string) => text.replace(/[\p{Cf}\s]/gu, '').length > 0;

export const supportChatContract = {
  session: oc
    .route({ method: 'POST', path: '/support-chat/session' })
    .output(SupportChatCustomerTokenSchema),

  createTicket: oc
    .route({ method: 'POST', path: '/support-chat/tickets' })
    .input(
      z
        .object({
          subject: z
            .string()
            .trim()
            .min(1)
            .max(SUPPORT_TICKET_SUBJECT_MAX)
            .refine(hasVisibleText, 'Subject has no visible text'),
          message: z
            .string()
            .trim()
            .min(1)
            .max(SUPPORT_TICKET_MESSAGE_MAX)
            .refine(hasVisibleText, 'Message has no visible text'),
        })
        .strict(),
    )
    .output(z.object({ success: z.literal(true) })),

  playerHistory: oc
    .route({ method: 'GET', path: '/support-chat/admin/players/{userId}/history' })
    .input(z.object({ userId: UuidSchema, includeResolved: QueryBooleanSchema.optional() }))
    .output(SupportHistorySchema),
};

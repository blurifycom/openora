import * as z from 'zod';
import { oc } from '@orpc/contract';
import {
  QueryBooleanSchema,
  SupportChatCustomerTokenSchema,
  SupportHistorySchema,
  UuidSchema,
} from '@openora/core/contracts';

export const supportChatContract = {
  // Takes no input: always the caller's own player.
  session: oc
    .route({ method: 'POST', path: '/support-chat/session' })
    .output(SupportChatCustomerTokenSchema),

  // A player's vendor tickets and chat threads for the back office. Resolved tickets only when
  // `includeResolved` is true.
  playerHistory: oc
    .route({ method: 'GET', path: '/support-chat/admin/players/{userId}/history' })
    .input(z.object({ userId: UuidSchema, includeResolved: QueryBooleanSchema.optional() }))
    .output(SupportHistorySchema),
};

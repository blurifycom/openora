import { oc } from '@orpc/contract';
import { SupportChatCustomerTokenSchema } from '@openora/core/contracts';

export const supportChatContract = {
  // Takes no input: always the caller's own player.
  session: oc
    .route({ method: 'POST', path: '/support-chat/session' })
    .output(SupportChatCustomerTokenSchema),
};

import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  SystemChatMessageSchema,
  CommandChatMessageSchema,
  ChatMoneyCommandInputSchema,
} from '@openora/core/contracts';

export { SystemChatMessageSchema, CommandChatMessageSchema };

export const SendDonateInputSchema = ChatMoneyCommandInputSchema.extend({
  targetUsername: z.string().min(1),
});
export type SendDonateInput = z.infer<typeof SendDonateInputSchema>;

// sendGift/claimGift/sendRain are NOT public routes here - they are consumed by
// `chat-commands` exclusively through the GIFT_COMMANDS/RAIN_COMMANDS ports (see
// AGENTS.md). Only `sendDonate` (no online-presence dependency) stays this
// module's own oRPC operation.
export const socialTransfersContract = {
  sendDonate: oc
    .route({ method: 'POST', path: '/social-transfers/donate' })
    .input(SendDonateInputSchema)
    .output(CommandChatMessageSchema),
};

import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  ChatRoomIdSchema,
  CommandChatMessageSchema,
  SystemChatMessageSchema,
} from '../schemas/chat-command.js';
import { MoneyAmountSchema, UuidSchema } from '../schemas/common.js';

export const SendDonateInputSchema = z.object({
  targetUsername: z.string().min(1),
  amount: MoneyAmountSchema,
  roomId: ChatRoomIdSchema,
  idempotencyKey: UuidSchema,
});
export type SendDonateInput = z.infer<typeof SendDonateInputSchema>;

export { SystemChatMessageSchema, CommandChatMessageSchema };

export const socialTransfersContract = {
  sendDonate: oc
    .route({ method: 'POST', path: '/social-transfers/donate' })
    .input(SendDonateInputSchema)
    .output(CommandChatMessageSchema),
};

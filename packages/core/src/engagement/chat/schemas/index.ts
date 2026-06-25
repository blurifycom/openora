import {
  ChatRoomSchema,
  ChatMessageSchema,
  BlockedUserSchema,
  chatContract,
} from '../contract/index.js';
import type { z } from 'zod';

export { ChatRoomSchema, ChatMessageSchema, BlockedUserSchema, chatContract };

export type ChatRoom = z.infer<typeof ChatRoomSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type BlockedUser = z.infer<typeof BlockedUserSchema>;

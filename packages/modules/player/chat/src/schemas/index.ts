import { ChatRoomSchema, ChatMessageSchema, chatContract } from '@oss/orpc-contract/chat';
import type { z } from 'zod';

export { ChatRoomSchema, ChatMessageSchema, chatContract };

export type ChatRoom = z.infer<typeof ChatRoomSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

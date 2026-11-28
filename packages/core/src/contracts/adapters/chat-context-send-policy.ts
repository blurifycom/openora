import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';
import {
  CHAT_CONTEXT_SEND_DENIED_REASON,
  type ChatContextSendDecision,
  type ChatContextSendDeniedData,
} from '../schemas/chat-context-room.js';

export type ChatContextSendPolicy = {
  check(input: {
    userId: Uuid;
    roomId: Uuid;
    contextRef: string;
    tx: unknown;
  }): Promise<ChatContextSendDecision>;
};

export class ChatContextSendDeniedError extends Error {
  readonly data: ChatContextSendDeniedData;

  constructor(policyReason: ChatContextSendDeniedData['policyReason']) {
    super(`Refused by the room's send policy: ${policyReason}`);
    this.name = 'ChatContextSendDeniedError';
    this.data = { reason: CHAT_CONTEXT_SEND_DENIED_REASON, policyReason };
  }
}

export const CHAT_CONTEXT_SEND_POLICY: Token<ChatContextSendPolicy> = createToken(
  'CHAT_CONTEXT_SEND_POLICY',
);

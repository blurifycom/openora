import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';
import {
  CHAT_CONTEXT_SEND_DENIED_REASON,
  type ChatContextSendDecision,
  type ChatContextSendDeniedData,
} from '../schemas/chat-context-room.js';

/**
 * Vetoes a player's message to a context room, on top of membership, bans, mutes and closing.
 * Chat asks it for every message a player sends to a room of kind `context`; never for a standard
 * room or for `CHAT_SYSTEM_WRITER`, so a command that posts there consults the policy itself before
 * its side effect.
 *
 * When chat calls it, `tx` is the send's transaction and already holds a shared lock on the room:
 * read the state the decision rests on through it, and do no network I/O while it is open. To lock
 * a row a concurrent change must not slip past, make any transaction that changes that row do its
 * `CHAT_CONTEXT_ROOMS` write first, or the two deadlock. A throw or a malformed decision refuses the
 * send. The sender sees `reason`, so keep it a generic code. Chat binds an allow-all default; a
 * consumer rebinds the token from a plugin that declares `dependsOn: ['chat']`, so it registers
 * after the default.
 */
export type ChatContextSendPolicy = {
  check(input: {
    userId: Uuid;
    roomId: Uuid;
    contextRef: string;
    tx: unknown;
  }): Promise<ChatContextSendDecision>;
};

/** The router answers FORBIDDEN with `data.reason` `context_send_denied` and the policy's own `policyReason`. */
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

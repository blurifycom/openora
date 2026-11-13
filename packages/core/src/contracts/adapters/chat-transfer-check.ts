import { createToken, type Token } from './token.js';
import type {
  ChatTransferCheckInput,
  ChatTransferVerdict,
} from '../schemas/chat-transfer-check.js';

/**
 * Every chat-side fact a money transfer in chat (gift, its claim, rain, donate) rests on, read
 * in one call: the command is enabled, the actor may post to the room, a context room's send
 * policy allows it, and which counterparts are in a block with the actor. The caller owns the
 * money; it calls this inside its transaction, before it locks a wallet, and refuses or drops
 * recipients from the verdict. Input and verdict are plain data, so a remote binding can serve it.
 *
 * It checks the actor only: a mute does not stop a transfer, and a counterpart's own bans are not
 * read. A context room's `contextRef` comes back so the caller can apply its own rule per context.
 *
 * Chat-commands binds the local implementation. It requires `tx` and reads everything through
 * it, and it holds a shared lock per pair against `blockUser` until that transaction ends, so a
 * block either commits before the check and refuses, or waits for the money to commit. Bans and
 * membership take no lock: one that commits after the read and before the money commits is not
 * seen, for as long as the caller's transaction runs. A remote binding holds no lock at all, so
 * blocks get that same window, plus whatever its cache adds. A binding that cannot answer throws
 * `ChatTransferCheckUnavailableError`; callers go through `checkChatTransfer`, which turns it
 * into a `chat_unavailable` refusal, so a transfer never moves money on an unanswered check.
 */
export type ChatTransferCheck = {
  check(tx: unknown, input: ChatTransferCheckInput): Promise<ChatTransferVerdict>;
};

export class ChatTransferCheckUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Chat could not answer the transfer check', options);
    this.name = 'ChatTransferCheckUnavailableError';
  }
}

/** Fail closed: an unavailable chat refuses the transfer instead of letting it through. */
export async function checkChatTransfer(
  port: ChatTransferCheck,
  tx: unknown,
  input: ChatTransferCheckInput,
): Promise<ChatTransferVerdict> {
  try {
    return await port.check(tx, input);
  } catch (error) {
    if (error instanceof ChatTransferCheckUnavailableError) {
      return { allowed: false, refusal: 'chat_unavailable' };
    }
    throw error;
  }
}

export const CHAT_TRANSFER_CHECK: Token<ChatTransferCheck> = createToken('CHAT_TRANSFER_CHECK');

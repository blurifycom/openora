import { createToken, type Token } from './token.js';
import {
  ChatTransferCheckInputSchema,
  ChatTransferVerdictSchema,
  type ChatTransferCheckInput,
  type ChatTransferVerdict,
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
 * blocks get that same window. Tip and transfer commands move money through `guardChatTransfer`,
 * which checks again after the caller's debit and ledger rows and throws inside its transaction
 * on a refusal or a counterpart blocked since; without a lock shared across services the window
 * never closes completely. A binding that cannot answer throws `ChatTransferCheckUnavailableError`,
 * which `checkChatTransfer` turns into a `chat_unavailable` refusal, so a transfer never moves
 * money on an unanswered check.
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

export type AllowedChatTransfer = Extract<ChatTransferVerdict, { allowed: true }>;

/** The transfer check refused, before the money moved or after; `verdict` is the refusing answer. */
export class ChatTransferRefusedError extends Error {
  constructor(readonly verdict: ChatTransferVerdict) {
    super(
      verdict.allowed
        ? 'A transfer counterpart was blocked while the transfer ran'
        : `Chat refused the transfer: ${verdict.refusal}`,
    );
    this.name = 'ChatTransferRefusedError';
  }
}

/**
 * The way a tip or transfer command moves money against {@link ChatTransferCheck}: checks, runs
 * `commit` (the caller's debit and ledger rows, on `tx`) with the allowed verdict, then checks
 * again before returning. A refusal either time, or a counterpart blocked since the first check,
 * throws {@link ChatTransferRefusedError}; the second one throws inside the caller's transaction,
 * so it rolls the money back. Locally the second check is a no-op the block locks already
 * guarantee; remotely it narrows the lock-free window to the time between it and the commit.
 */
export async function guardChatTransfer<T>(
  port: ChatTransferCheck,
  tx: unknown,
  input: ChatTransferCheckInput,
  commit: (verdict: AllowedChatTransfer) => Promise<T>,
): Promise<T> {
  const first = await checkChatTransfer(port, tx, input);
  if (!first.allowed) {
    throw new ChatTransferRefusedError(first);
  }
  const result = await commit(first);
  const second = await checkChatTransfer(port, tx, input);
  if (!second.allowed || second.blockedIds.some((id) => !first.blockedIds.includes(id))) {
    throw new ChatTransferRefusedError(second);
  }
  return result;
}

export const CHAT_TRANSFER_CHECK: Token<ChatTransferCheck> = createToken('CHAT_TRANSFER_CHECK');

/**
 * The chat service's internal route behind {@link ChatTransferCheck}, under `/internal/v1`. The
 * service answers on a transaction of its own, so a caller on another service gets the verdict
 * without the block locks the local binding holds (ADR-0060).
 */
export const CHAT_TRANSFER_CHECK_ROUTES = { check: '/chat-commands/transfer-check' } as const;

/** Request and reply of the route in {@link CHAT_TRANSFER_CHECK_ROUTES}, for the server and the client. */
export const ChatTransferCheckWire = {
  check: { input: ChatTransferCheckInputSchema, output: ChatTransferVerdictSchema },
} as const;

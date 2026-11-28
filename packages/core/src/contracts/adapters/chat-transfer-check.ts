import { createToken, type Token } from './token.js';
import {
  ChatTransferCheckInputSchema,
  ChatTransferVerdictSchema,
  type ChatTransferCheckInput,
  type ChatTransferVerdict,
} from '../schemas/chat-transfer-check.js';

export type ChatTransferCheck = {
  check(tx: unknown, input: ChatTransferCheckInput): Promise<ChatTransferVerdict>;
};

export class ChatTransferCheckUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Chat could not answer the transfer check', options);
    this.name = 'ChatTransferCheckUnavailableError';
  }
}

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

export const CHAT_TRANSFER_CHECK_ROUTES = { check: '/chat-commands/transfer-check' } as const;

export const ChatTransferCheckWire = {
  check: { input: ChatTransferCheckInputSchema, output: ChatTransferVerdictSchema },
} as const;

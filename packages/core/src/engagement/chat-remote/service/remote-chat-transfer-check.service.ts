import {
  CHAT_TRANSFER_CHECK_ROUTES,
  ChatTransferCheckInputSchema,
  ChatTransferCheckUnavailableError,
  ChatTransferCheckWire,
  type ChatTransferCheck,
  type ChatTransferCheckInput,
  type ChatTransferVerdict,
} from '@openora/core/contracts';
import { createLogger, type InternalClient } from '@openora/core/server';

const logger = createLogger('chat-remote-transfer-check');

/**
 * {@link ChatTransferCheck} over the chat service's internal API, for a service that does not
 * load chat. It gates a money transfer, so it never caches and every failure refuses: a call
 * that times out, never connects, is refused or answers something unreadable throws
 * `ChatTransferCheckUnavailableError`, which `checkChatTransfer` turns into a `chat_unavailable`
 * refusal. The caller's `tx` is not used: chat answers on its own, so the block locks the local
 * binding holds until the caller commits do not exist here.
 */
export class RemoteChatTransferCheck implements ChatTransferCheck {
  constructor(private readonly client: InternalClient) {}

  async check(_tx: unknown, rawInput: ChatTransferCheckInput): Promise<ChatTransferVerdict> {
    // A bad input is the caller's bug, as with the local binding, not an unavailable chat.
    const input = ChatTransferCheckInputSchema.parse(rawInput);
    try {
      return ChatTransferCheckWire.check.output.parse(
        await this.client.request('POST', CHAT_TRANSFER_CHECK_ROUTES.check, input),
      );
    } catch (error) {
      logger.warn({ err: error }, 'chat transfer check failed, refusing the transfer');
      throw new ChatTransferCheckUnavailableError({ cause: error });
    }
  }
}

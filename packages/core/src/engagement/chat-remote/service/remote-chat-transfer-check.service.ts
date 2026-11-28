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

export class RemoteChatTransferCheck implements ChatTransferCheck {
  constructor(private readonly client: InternalClient) {}

  async check(_tx: unknown, rawInput: ChatTransferCheckInput): Promise<ChatTransferVerdict> {
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

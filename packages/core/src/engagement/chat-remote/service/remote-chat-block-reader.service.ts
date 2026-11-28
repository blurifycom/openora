import {
  CHAT_BLOCK_READER_ROUTES,
  ChatBlockReaderWire,
  type ChatBlockReader,
  type Uuid,
} from '@openora/core/contracts';
import { upstreamDownAs503, type InternalClient } from '@openora/core/server';

export class RemoteChatBlockReader implements ChatBlockReader {
  constructor(private readonly client: InternalClient) {}

  getExcludedUserIds(viewerId: Uuid): Promise<string[]> {
    return this.read('excluded', viewerId);
  }

  getBlockedUserIds(viewerId: Uuid): Promise<string[]> {
    return this.read('blocked', viewerId);
  }

  getBlockerIds(userId: Uuid): Promise<string[]> {
    return this.read('blockers', userId);
  }

  private async read(route: keyof typeof CHAT_BLOCK_READER_ROUTES, userId: Uuid) {
    try {
      const reply = ChatBlockReaderWire[route].output.parse(
        await this.client.request('POST', CHAT_BLOCK_READER_ROUTES[route], { userId }),
      );
      return reply.userIds;
    } catch (err) {
      throw upstreamDownAs503(err);
    }
  }
}

import {
  CHAT_BLOCK_READER_ROUTES,
  ChatBlockReaderWire,
  type ChatBlockReader,
  type Uuid,
} from '@openora/core/contracts';
import { upstreamDownAs503, type InternalClient } from '@openora/core/server';

/**
 * {@link ChatBlockReader} over the chat service's internal API, for a service that does not
 * load chat. Never cached and never answered from a guess: a call that cannot be made, or whose
 * reply does not parse, throws, so a caller never reads a failed lookup as "nobody is blocked".
 * An unreachable chat service (timeout, network failure, 5xx) throws a 503 `SERVICE_UNAVAILABLE`;
 * a refused call (4xx, such as a caller missing from `CHAT_BLOCK_READER_CALLERS`) stays a 500.
 */
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

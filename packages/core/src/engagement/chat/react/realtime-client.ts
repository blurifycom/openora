import {
  createClient,
  createSseRealtimeClientAdapter,
  type CreateClientOptions,
  type RealtimeClientAdapter,
  type RealtimeSubscribeHandlers,
} from '@openora/core/react';
import { chatChannel, GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { chatContract } from '../contract/index.js';

function streamInputFor(channel: string) {
  if (channel === chatChannel(null)) {
    return {};
  }
  const roomId = channel.slice(channel.lastIndexOf(':') + 1);
  if (chatChannel(roomId) !== channel) {
    throw new TypeError(`Not a chat channel: ${channel}`);
  }
  return roomId === GLOBAL_CHAT_ROOM_ID ? {} : { roomId };
}

export function createChatSseRealtimeClientAdapter(
  options: CreateClientOptions,
): RealtimeClientAdapter {
  const client = createClient(chatContract, options);
  const adapter = createSseRealtimeClientAdapter({
    open: (channel, signal) => client.streamRoom(streamInputFor(channel), { signal }),
  });
  return {
    ...adapter,
    subscribe<T>(channel: string, handlers: RealtimeSubscribeHandlers<T>) {
      streamInputFor(channel);
      return adapter.subscribe(channel, handlers);
    },
  };
}

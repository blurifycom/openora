'use client';

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { ChatMessageSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { useOrpcClient } from './use-orpc-client.js';
import { useEventStream, type EventStreamStatus } from './use-event-stream.js';

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export type UseChatStreamOptions = {
  // Messages already loaded (eg from an initial getRoomMessages/getGlobalMessages
  // fetch) to seed the list before the live stream attaches.
  initialMessages?: ChatMessage[];
  // When false, the stream is not opened.
  enabled?: boolean;
};

export type UseChatStreamResult = {
  messages: ChatMessage[];
  status: EventStreamStatus;
  // The React state setter (accepts a value or updater) - eg to merge a backfill
  // query result into the live list.
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
};

/**
 * Live chat feed for a room (`roomId: null` = the global channel). Subscribes to
 * `chat.streamMessages` over SSE via the generic `useEventStream` transport and
 * appends each message, de-duplicating by id (delivery is at-least-once). Pair
 * with an initial `getRoomMessages`/`getGlobalMessages` fetch for backfill.
 */
export function useChatStream(
  roomId: string | null,
  options: UseChatStreamOptions = {},
): UseChatStreamResult {
  const { initialMessages = [], enabled = true } = options;
  const client = useOrpcClient();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);

  const subscribe = useCallback(
    (signal: AbortSignal) => client.chat.streamMessages({ roomId }, { signal }),
    [client, roomId],
  );

  const { status } = useEventStream<ChatMessage>(subscribe, {
    enabled,
    onEvent: (message) => {
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    },
  });

  return { messages, status, setMessages };
}

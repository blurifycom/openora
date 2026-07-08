'use client';

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { populateContractRouterPaths } from '@orpc/contract';
import type { z } from 'zod';
import {
  useOrpcClient,
  useEventStream,
  useOptionalRealtimeClient,
  type EventStreamStatus,
} from '@openora/core/react';
import { chatContract, ChatMessageSchema } from '../contract/index.js';

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

const chatRootContract = populateContractRouterPaths({ chat: chatContract });

const DEFAULT_MAX_MESSAGES = 500;

export type UseChatStreamOptions = {
  initialMessages?: ChatMessage[];
  enabled?: boolean;
  maxMessages?: number;
};

export type UseChatStreamResult = {
  messages: ChatMessage[];
  status: EventStreamStatus;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
};

// MUST mirror `chatChannel` in the chat service so the injected transport subscribes to the same channel the server publishes to.
function chatChannel(roomId: string | null): string {
  return roomId ? `chat:room:${roomId}` : 'chat:global';
}

/**
 * Live chat feed for a room (`roomId: null` = the global channel).
 *
 * Provider-agnostic by design: when a `RealtimeClientProvider` is mounted (eg a
 * consumer wiring Ably/GetStream), the feed subscribes through that injected
 * adapter so the client connects directly to the vendor. Otherwise it falls back
 * to the built-in first-party SSE transport (`chat.streamMessages`). Either way it
 * appends each message, de-duplicating by id (delivery is at-least-once). Pair
 * with an initial `getRoomMessages`/`getGlobalMessages` fetch for backfill.
 */
export function useChatStream(
  roomId: string | null,
  options: UseChatStreamOptions = {},
): UseChatStreamResult {
  const { initialMessages = [], enabled = true, maxMessages = DEFAULT_MAX_MESSAGES } = options;
  const client = useOrpcClient(chatRootContract);
  const adapter = useOptionalRealtimeClient();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [adapterStatus, setAdapterStatus] = useState<EventStreamStatus>('idle');

  const onMessage = useCallback(
    (message: ChatMessage) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === message.id)) return prev;
        const next = [...prev, message];
        return next.length > maxMessages ? next.slice(next.length - maxMessages) : next;
      });
    },
    [maxMessages],
  );

  const subscribe = useCallback(
    (signal: AbortSignal) => client.chat.streamMessages({ roomId }, { signal }),
    [client, roomId],
  );
  const { status: sseStatus } = useEventStream<ChatMessage>(subscribe, {
    enabled: enabled && !adapter,
    onEvent: onMessage,
  });

  useEffect(() => {
    if (!adapter || !enabled) return;
    return adapter.subscribe<ChatMessage>(chatChannel(roomId), {
      onMessage,
      onStatus: setAdapterStatus,
    });
  }, [adapter, enabled, roomId, onMessage]);

  const status = adapter ? (enabled ? adapterStatus : 'idle') : sseStatus;
  return { messages, status, setMessages };
}

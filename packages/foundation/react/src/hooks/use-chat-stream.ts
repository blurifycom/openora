'use client';

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { ChatMessageSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { useOrpcClient } from './use-orpc-client.js';
import { useEventStream, type EventStreamStatus } from './use-event-stream.js';
import { useOptionalRealtimeClient } from '../context/realtime-client.js';

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// Cap the in-memory buffer so a long-lived session does not grow the array (and
// the DOM) without bound. Oldest messages drop first.
const DEFAULT_MAX_MESSAGES = 500;

export type UseChatStreamOptions = {
  // Messages already loaded (eg from an initial getRoomMessages/getGlobalMessages
  // fetch) to seed the list before the live stream attaches.
  initialMessages?: ChatMessage[];
  // When false, the stream is not opened.
  enabled?: boolean;
  // Maximum messages retained in memory (oldest dropped first). Default 500.
  maxMessages?: number;
};

export type UseChatStreamResult = {
  messages: ChatMessage[];
  status: EventStreamStatus;
  // The React state setter (accepts a value or updater) - eg to merge a backfill
  // query result into the live list.
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
};

// The realtime channel for a room (null = global). MUST mirror `chatChannel` in
// the chat module's service (the canonical naming convention) so the injected
// transport subscribes to the same channel the server publishes to. Kept local
// because @oss/react cannot import a module's internals (boundary rule).
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
  const client = useOrpcClient();
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

  // Built-in SSE transport - only active when no client adapter is injected.
  const subscribe = useCallback(
    (signal: AbortSignal) => client.chat.streamMessages({ roomId }, { signal }),
    [client, roomId],
  );
  const { status: sseStatus } = useEventStream<ChatMessage>(subscribe, {
    enabled: enabled && !adapter,
    onEvent: onMessage,
  });

  // Injected transport (eg Ably): subscribe to the channel directly.
  useEffect(() => {
    if (!adapter || !enabled) return;
    return adapter.subscribe<ChatMessage>(chatChannel(roomId), {
      onMessage,
      onStatus: setAdapterStatus,
    });
  }, [adapter, enabled, roomId, onMessage]);

  // When the adapter is injected but the feed is disabled (eg a closed panel), the
  // last connection state is stale - report 'idle' so the UI does not show "Live".
  const status = adapter ? (enabled ? adapterStatus : 'idle') : sseStatus;
  return { messages, status, setMessages };
}

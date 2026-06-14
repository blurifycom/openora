'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';

// Pluggable client-side realtime transport.
//
// The platform is provider-agnostic: the DEFAULT receive model is first-party SSE
// (the chat hook pulls `chat.streamMessages` off the oRPC client - no provider
// needed). A consumer that connects clients directly to a managed vendor
// (Ably/GetStream) injects an adapter here; the chat hook then subscribes through
// it instead of opening the SSE stream. The adapter is an opaque object the
// consumer builds with whatever its SDK needs (it fetches `/chat/connection` for
// the backend-minted grant/token itself). Core ships no vendor SDK. See ADR-0007.

export type RealtimeClientStatus = 'idle' | 'connecting' | 'open' | 'closed';

export type RealtimeSubscribeHandlers<T> = {
  // Invoked for each message delivered on the channel.
  onMessage: (event: T) => void;
  // Optional connection-state callback (drives "reconnecting" UX, eg internal).
  onStatus?: (status: RealtimeClientStatus) => void;
};

export type RealtimeClientAdapter = {
  // Subscribe to a logical channel (eg `chat:global`). Returns an unsubscribe fn
  // the caller MUST invoke on teardown.
  subscribe<T>(channel: string, handlers: RealtimeSubscribeHandlers<T>): () => void;
  // Optional: release the underlying connection/socket. The provider calls this on
  // unmount so a vendor adapter (eg Ably) does not leak a WebSocket across
  // Fast-Refresh / StrictMode remounts.
  close?(): void;
};

const RealtimeClientContext = createContext<RealtimeClientAdapter | null>(null);

export function RealtimeClientProvider({
  adapter,
  children,
}: {
  adapter: RealtimeClientAdapter;
  children: ReactNode;
}) {
  // Own the adapter's connection lifecycle: release it on unmount (or when the
  // adapter instance changes) so a vendor socket is not leaked across remounts.
  useEffect(() => () => adapter.close?.(), [adapter]);
  return (
    <RealtimeClientContext.Provider value={adapter}>{children}</RealtimeClientContext.Provider>
  );
}

// Returns null when no provider is mounted, so the chat hook falls back to the
// built-in SSE transport (the default first-party model). Intentionally optional.
export function useOptionalRealtimeClient(): RealtimeClientAdapter | null {
  return useContext(RealtimeClientContext);
}

'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';

// Pluggable client-side realtime transport. Default receive model is first-party
// SSE; a consumer targeting a managed vendor (Ably/GetStream) injects an adapter
// here instead. Core ships no vendor SDK. See ADR-0007.

export type RealtimeClientStatus = 'idle' | 'connecting' | 'open' | 'closed';

export type RealtimeSubscribeHandlers<T> = {
  onMessage: (event: T) => void;
  // Optional: drives "reconnecting" UX (eg internal).
  onStatus?: (status: RealtimeClientStatus) => void;
};

export type RealtimeClientAdapter = {
  /** Returns an unsubscribe fn the caller MUST invoke on teardown. */
  subscribe<T>(channel: string, handlers: RealtimeSubscribeHandlers<T>): () => void;
  // Optional: vendor adapters (eg Ably) must implement this to avoid leaking a
  // WebSocket across Fast-Refresh / StrictMode remounts.
  close?(): void;
  // Optional: called after channel membership changes (eg joining a private room) so
  // vendor adapters can issue a new auth token covering the new channel before subscribe.
  refresh?(): void;
};

const RealtimeClientContext = createContext<RealtimeClientAdapter | null>(null);

export function RealtimeClientProvider({
  adapter,
  children,
}: {
  adapter: RealtimeClientAdapter;
  children: ReactNode;
}) {
  useEffect(() => () => adapter.close?.(), [adapter]);
  return (
    <RealtimeClientContext.Provider value={adapter}>{children}</RealtimeClientContext.Provider>
  );
}

/** Returns null when no provider is mounted; the chat hook falls back to built-in SSE. */
export function useOptionalRealtimeClient(): RealtimeClientAdapter | null {
  return useContext(RealtimeClientContext);
}

'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';

// Pluggable client-side realtime transport. Default receive model is first-party
// SSE; a consumer targeting a managed vendor (Ably/GetStream) injects an adapter
// here instead. Core ships no vendor SDK. See ADR-0007.

export type RealtimeClientStatus = 'idle' | 'connecting' | 'open' | 'closed';

export type RealtimeSubscribeHandlers<T> = {
  /**
   * The channel's payload stream - for chat, a `ChatMessage`. Its shape is the channel's
   * contract, which is why it is typed and `onSignal`'s payload is not.
   */
  onMessage: (event: T) => void;
  // Optional: drives "reconnecting" UX (eg internal).
  onStatus?: (status: RealtimeClientStatus) => void;
  /**
   * Optional: the receiving half of `RealtimeTransport.signal` (contracts/adapters/realtime.ts).
   * A named control signal - "something about this channel changed, refetch" - delivered on its
   * own lane, so it never reaches `onMessage` and cannot corrupt the payload stream. `payload` is
   * `unknown` on purpose: the vocabulary of names is open, so the caller parses what it asked
   * for (eg `ChatMemberRoleChangedSignalSchema` for `chat:member-role-changed`) and ignores the
   * rest. Only a managed transport delivers these: the first-party SSE path carries one payload
   * lane per channel, exactly as noted on `RealtimeTransport.signal`, so an SSE-backed adapter
   * simply never calls this.
   */
  onSignal?: (name: string, payload: unknown) => void;
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

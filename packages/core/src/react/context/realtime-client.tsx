'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';

export type RealtimeClientStatus = 'idle' | 'connecting' | 'open' | 'closed';

export type RealtimeSubscribeHandlers<T> = {
  onMessage: (event: T) => void;
  onStatus?: (status: RealtimeClientStatus) => void;
  onSignal?: (name: string, payload: unknown) => void;
};

export type RealtimeClientAdapter = {
  subscribe<T>(channel: string, handlers: RealtimeSubscribeHandlers<T>): () => void;
  close?(): void;
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

export function useOptionalRealtimeClient(): RealtimeClientAdapter | null {
  return useContext(RealtimeClientContext);
}

// Realtime-transport seam. Client-facing push (live chat messages, PvP round
// state, live odds, big-win/jackpot feeds) flows through this adapter, so the
// transport is swappable: the default binding is a first-party in-process
// fan-out (served to clients as oRPC event-iterators over SSE); a downstream
// operator binds a managed transport (Ably / GetStream / PubNub) to
// REALTIME_TRANSPORT without touching modules. This realizes ADR-0007's
// `ChatTransportPort` as a generic primitive shared across modules - it is NOT
// the inter-module MESSAGE_BROKER (ADR-0010 #4 keeps client push separate from
// the event broker, which has delivery guarantees/acks). Money and moderation
// stay first-party domain logic; they are never delegated to the transport.
import { createToken, type Token } from './token.js';

// Optional presence capability. A first-party transport can offer a simple
// connected-member count; managed vendors provide richer presence. Kept optional
// (a capability flag, per ADR-0007) so the base port is the common denominator.
export type RealtimePresence = {
  join(channel: string, memberId: string): void;
  leave(channel: string, memberId: string): void;
  count(channel: string): number;
};

export type RealtimeTransport = {
  // Fan a message out to every subscriber of `channel`. Best-effort, at-most-once
  // for late joiners (the transport is not a system of record - persist first).
  publish<T>(channel: string, event: T): void | Promise<void>;
  // Subscribe a handler to a channel. Returns an unsubscribe fn the caller MUST
  // invoke on teardown (eg an SSE handler on request abort).
  subscribe<T>(channel: string, handler: (event: T) => void): () => void;
  presence?: RealtimePresence;
};

export const REALTIME_TRANSPORT: Token<RealtimeTransport> = createToken('REALTIME_TRANSPORT');

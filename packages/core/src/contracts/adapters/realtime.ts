/**
 * Realtime-transport seam. Client-facing push (live chat messages, PvP round
 * state, live odds, big-win/jackpot feeds) flows through this adapter, so the
 * transport is swappable: the default binding is a first-party in-process
 * fan-out (served to clients as oRPC event-iterators over SSE); a downstream
 * operator binds a managed transport (Ably / GetStream / PubNub) to
 * REALTIME_TRANSPORT without touching modules. This realizes ADR-0007's
 * `ChatTransportPort` as a generic primitive shared across modules - it is NOT
 * the inter-module MESSAGE_BROKER (ADR-0010 #4 keeps client push separate from
 * the event broker, which has delivery guarantees/acks). Money and moderation
 * stay first-party domain logic; they are never delegated to the transport.
 *
 * CHAT_REALTIME_TRANSPORT / CHAT_REALTIME_CLIENT_AUTHORIZER are the SAME two
 * port shapes, scoped to chat only. The chat module defaults them to whatever
 * REALTIME_TRANSPORT/REALTIME_CLIENT_AUTHORIZER resolve to (so out of the box
 * chat behaves identically to every other realtime consumer), but an operator
 * can rebind just the CHAT_-prefixed tokens to run chat on a managed vendor
 * (eg Ably) while KYC status updates and everything else stay first-party SSE
 * - the two seams are independently swappable. `chat-commands` shares the SAME
 * chat channels (gift claims, rain), so it consumes CHAT_REALTIME_TRANSPORT
 * too, never the generic token.
 */
import { createToken, type Token } from './token.js';

/**
 * Optional presence capability. A first-party transport can offer a simple
 * connected-member count; managed vendors provide richer presence. Kept optional
 * (a capability flag, per ADR-0007) so the base port is the common denominator.
 */
export type RealtimePresence = {
  /**
   * `connectionId` distinguishes concurrent tabs for the same member. Counts remain
   * per member, so one tab leaving never marks a user offline while another is active.
   */
  join(channel: string, memberId: string, connectionId: string): void;
  leave(channel: string, memberId: string, connectionId: string): void;
  count(channel: string): number | Promise<number>;
};

export type RealtimeTransport = {
  /**
   * Fan a message out to every subscriber of `channel`. Best-effort, at-most-once
   * for late joiners (the transport is not a system of record - persist first).
   */
  publish<T>(channel: string, event: T): void | Promise<void>;
  /**
   * Subscribe a handler to a channel. Returns an unsubscribe fn the caller MUST
   * invoke on teardown (eg an SSE handler on request abort).
   */
  subscribe<T>(channel: string, handler: (event: T) => void): () => void;
  /** Revoke managed-provider credentials for a client after access is removed. */
  revokeClient?: (clientId: string) => void | Promise<void>;
  presence?: RealtimePresence;
  /**
   * Returns the set of authenticated user IDs currently online in `channel`.
   * Anonymous connections (memberIds beginning with 'anonymous:') are excluded.
   */
  getOnlineUserIds(channel: string): Promise<string[]>;
};

export const REALTIME_TRANSPORT: Token<RealtimeTransport> = createToken('REALTIME_TRANSPORT');

/** Chat-scoped realtime transport - see the module header comment above. */
export const CHAT_REALTIME_TRANSPORT: Token<RealtimeTransport> =
  createToken('CHAT_REALTIME_TRANSPORT');

/**
 * Client connection provisioning - the complement to REALTIME_TRANSPORT.
 *
 * REALTIME_TRANSPORT is how the SERVER fans a message out. This seam is how a
 * CLIENT learns to CONNECT and receive. The two models differ by provider:
 *   - first-party (default): the client pulls from our own API over SSE, so the
 *     "grant" is just the stream path - no secret, the session cookie authorizes.
 *   - managed vendor (Ably/GetStream/PubNub): the client connects DIRECTLY to the
 *     vendor edge, so the backend must mint a per-player, capability-scoped token
 *     (never ship the vendor API key to the browser). The grant carries that token.
 * A downstream operator binds this token to its provider's authorizer without any
 * module change; the chat module just hands the grant to the caller. See ADR-0007.
 */

/**
 * What the client needs to start receiving, tagged by `provider` so a pluggable
 * client-side adapter can pick the right transport. Open union - a new vendor adds
 * its own variant without editing core.
 */
export type RealtimeConnectionGrant =
  /** First-party SSE: subscribe by opening this event-iterator path on our API. */
  | { provider: 'sse'; streamPath: string; channels: string[] }
  /**
   * Ably: a signed TokenRequest the browser exchanges for a scoped token, plus the
   * channels the player may subscribe to. `tokenRequest` is opaque here (the Ably
   * SDK shape lives in the consumer, not in vendor-neutral core).
   */
  | { provider: 'ably'; tokenRequest: unknown; channels: string[] }
  /** Escape hatch for any other vendor (GetStream, PubNub, ...). */
  | { provider: string; channels: string[]; [key: string]: unknown };

export type RealtimeClientAuthorizerInput = {
  /**
   * The authenticated caller; becomes the vendor `clientId` so presence/identity
   * is bound server-side and cannot be spoofed by the browser.
   */
  userId: string;
  /** A stable per-connection id from the client (defaults to userId when absent). */
  clientId: string;
  /**
   * The channels the caller is allowed to subscribe to (the module computes these
   * from the player's access - eg the global channel plus their rooms).
   */
  channels: string[];
};

export type RealtimeClientAuthorizer = {
  /**
   * Mint a connection grant for an authenticated caller. Async because a managed
   * vendor signs a token request over its SDK.
   */
  issueGrant(
    input: RealtimeClientAuthorizerInput,
  ): RealtimeConnectionGrant | Promise<RealtimeConnectionGrant>;
};

export const REALTIME_CLIENT_AUTHORIZER: Token<RealtimeClientAuthorizer> = createToken(
  'REALTIME_CLIENT_AUTHORIZER',
);

/** Chat-scoped client authorizer - see the module header comment above. */
export const CHAT_REALTIME_CLIENT_AUTHORIZER: Token<RealtimeClientAuthorizer> = createToken(
  'CHAT_REALTIME_CLIENT_AUTHORIZER',
);

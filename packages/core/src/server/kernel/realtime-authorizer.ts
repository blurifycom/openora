import type {
  RealtimeClientAuthorizer,
  RealtimeClientAuthorizerInput,
  RealtimeConnectionGrant,
} from '../../contracts/adapters/index.js';

// Default REALTIME_CLIENT_AUTHORIZER binding - the first-party SSE model.
//
// There is no token to mint: the client subscribes by opening the chat
// event-iterator path on our own API, and the session cookie already authorizes
// it. So the grant is just the stream path plus the channels the caller may read.
// A downstream operator that connects clients directly to a managed vendor
// (Ably/GetStream) rebinds REALTIME_CLIENT_AUTHORIZER in an overlay to return a
// per-player, capability-scoped token instead - no module change. See ADR-0007.

export type SseClientAuthorizerOptions = {
  // The event-iterator path clients open to receive. Defaults to the chat stream.
  streamPath?: string;
};

export class SseClientAuthorizer implements RealtimeClientAuthorizer {
  private readonly streamPath: string;

  constructor(options: SseClientAuthorizerOptions = {}) {
    this.streamPath = options.streamPath ?? '/chat/stream';
  }

  issueGrant(input: RealtimeClientAuthorizerInput): RealtimeConnectionGrant {
    return { provider: 'sse', streamPath: this.streamPath, channels: input.channels };
  }
}

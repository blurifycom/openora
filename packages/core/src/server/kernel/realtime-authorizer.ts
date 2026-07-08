import type {
  RealtimeClientAuthorizer,
  RealtimeClientAuthorizerInput,
  RealtimeConnectionGrant,
} from '@openora/core/contracts';

// Default REALTIME_CLIENT_AUTHORIZER binding (first-party SSE). No token to mint:
// the session cookie already authorizes the chat event-iterator path. An operator
// targeting a managed vendor (Ably/GetStream) rebinds this in an overlay. See ADR-0007.

export type SseClientAuthorizerOptions = {
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

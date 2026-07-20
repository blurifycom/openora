import type {
  RealtimeClientAuthorizer,
  RealtimeClientAuthorizerInput,
  RealtimeConnectionGrant,
} from '@openora/core/contracts';

// Test-only `REALTIME_CLIENT_AUTHORIZER` double (first-party SSE, no token to
// mint - the session cookie already authorizes the chat event-iterator path). An
// operator targeting a managed vendor (Ably/GetStream) binds a real authorizer in
// an overlay. See ADR-0007.

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

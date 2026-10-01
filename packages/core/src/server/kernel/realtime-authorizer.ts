import type {
  RealtimeClientAuthorizer,
  RealtimeClientAuthorizerInput,
  RealtimeConnectionGrant,
} from '@openora/core/contracts';

/** First-party SSE grant; the session cookie authorizes the stream itself. */
export class SseClientAuthorizer implements RealtimeClientAuthorizer {
  constructor(private readonly streamPath = '/chat/stream') {}

  issueGrant(input: RealtimeClientAuthorizerInput): RealtimeConnectionGrant {
    return { provider: 'sse', streamPath: this.streamPath, channels: input.channels };
  }
}

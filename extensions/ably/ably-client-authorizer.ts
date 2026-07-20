import type {
  RealtimeClientAuthorizer,
  RealtimeClientAuthorizerInput,
  RealtimeConnectionGrant,
} from '@openora/core/contracts';

export type AblyTokenRequestParams = {
  clientId: string;
  ttl: number;
  capability: string;
};

export type AblyTokenRequestClient = {
  auth: {
    createTokenRequest(input: AblyTokenRequestParams): Promise<unknown>;
  };
};

const ABLY_SUBSCRIBE_CAPABILITIES = ['subscribe', 'presence'] as const;
const TOKEN_TTL_MS = 60 * 60 * 1_000;

/**
 * Mints short-lived Ably grants for exactly the channels the chat router has
 * authorized. The browser receives a TokenRequest, never the Ably API key.
 */
export class AblyClientAuthorizer implements RealtimeClientAuthorizer {
  constructor(private readonly rest: AblyTokenRequestClient) {}

  async issueGrant(input: RealtimeClientAuthorizerInput): Promise<RealtimeConnectionGrant> {
    const capability = Object.fromEntries(
      input.channels.map((channel) => [channel, ABLY_SUBSCRIBE_CAPABILITIES]),
    );
    const tokenRequest = await this.rest.auth.createTokenRequest({
      // Deliberately ignore clientId from the request: identity and presence are
      // bound to the authenticated player, not a browser-supplied identifier.
      clientId: input.userId,
      ttl: TOKEN_TTL_MS,
      capability: JSON.stringify(capability),
    });
    return { provider: 'ably', tokenRequest, channels: input.channels };
  }
}

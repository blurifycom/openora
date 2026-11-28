import { createToken, type Token } from './token.js';

export type RealtimePresence = {
  join(channel: string, memberId: string, connectionId: string): void;
  leave(channel: string, memberId: string, connectionId: string): void;
  count(channel: string): number | Promise<number>;
};

export type RealtimeSignal = { name: string; payload: unknown };

export const ACCESS_REVOKED_SIGNAL = 'chat:access-revoked';

export type RealtimeTransport = {
  publish<T>(channel: string, event: T): void | Promise<void>;
  remove<T>(channel: string, event: T): void | Promise<void>;
  subscribe<T>(channel: string, handler: (event: T) => void, userId?: string): () => void;
  signal?: (channel: string, name: string, payload: unknown) => void | Promise<void>;
  subscribeSignal?: (
    channel: string,
    handler: (signal: RealtimeSignal) => void,
    userId?: string,
  ) => () => void;
  revokeClient?: (clientId: string) => void | Promise<void>;
  revokeUserFromChannel?: (userId: string, channel: string) => void | Promise<void>;
  presence?: RealtimePresence;
  getOnlineUserIds(channel: string): Promise<string[]>;
};

export const REALTIME_TRANSPORT: Token<RealtimeTransport> = createToken('REALTIME_TRANSPORT');

export const CHAT_REALTIME_TRANSPORT: Token<RealtimeTransport> =
  createToken('CHAT_REALTIME_TRANSPORT');

export type RealtimeConnectionGrant =
  | { provider: 'sse'; streamPath: string; channels: string[] }
  | { provider: 'ably'; tokenRequest: unknown; channels: string[] }
  | { provider: string; channels: string[]; [key: string]: unknown };

export type RealtimeClientAuthorizerInput = {
  userId: string;
  clientId: string;
  channels: string[];
};

export type RealtimeClientAuthorizer = {
  issueGrant(
    input: RealtimeClientAuthorizerInput,
  ): RealtimeConnectionGrant | Promise<RealtimeConnectionGrant>;
};

export const REALTIME_CLIENT_AUTHORIZER: Token<RealtimeClientAuthorizer> = createToken(
  'REALTIME_CLIENT_AUTHORIZER',
);

export const CHAT_REALTIME_CLIENT_AUTHORIZER: Token<RealtimeClientAuthorizer> = createToken(
  'CHAT_REALTIME_CLIENT_AUTHORIZER',
);

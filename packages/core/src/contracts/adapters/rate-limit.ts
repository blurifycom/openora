import { createToken, type Token } from './token.js';

export const RATE_LIMIT_KEYS = {
  REGISTER: 'register',
  LOGIN: 'login',
  LOGIN_IP: 'login-ip',
  ENABLE_2FA: 'enable2fa',
  VERIFY_2FA: 'verify2fa',
  DISABLE_2FA: 'disable2fa',
  PASSWORD_RESET_REQUEST: 'pwreset-req',
  PASSWORD_RESET_VERIFY: 'pwreset-verify',
  PASSWORD_RESET: 'pwreset',
  CHANGE_PASSWORD: 'change-password',
  USERNAME_CHANGE: 'username-change',
  WITHDRAWAL_PIN_MUTATION: 'withdrawal-pin-mutation',
  WITHDRAWAL_ADDRESS_REAUTH: 'withdrawal-address-reauth',
  ANTI_PHISHING_CODE_MUTATION: 'anti-phishing-code-mutation',
  EMAIL_VERIFICATION: 'email-verify',
  VERIFY_EMAIL: 'verify-email',
  WALLET_MUTATION: 'wallet-mutation',
  WALLET_WEBHOOK: 'wallet-webhook',
  ON_RAMP: 'on-ramp',
  ON_RAMP_STATUS: 'on-ramp-status',
  CHAT_ROOM_JOIN: 'chat-room-join',
  CHAT_ROOM_INVITE: 'chat-room-invite',
  CHAT_ROOM_INVITE_LOOKUP: 'chat-room-invite-lookup',
  CHAT_SEND: 'chat-send',
  CHAT_MENTION_SEARCH: 'chat-mention-search',
  SUPPORT_CHAT_SESSION: 'support-chat-session',
  SUPPORT_CHAT_HISTORY: 'support-chat-history',
  SUPPORT_TICKET_CREATE: 'support-ticket-create',
  REPORT_ACCESS_DENIED: 'report-access-denied',
  GEO_CHECK_IP: 'geo-check-ip',
  PROMO_PUBLIC_OFFERS_IP: 'promo-public-offers-ip',
  RAKEBACK_CLAIM: 'rakeback-claim',
  RANK_REWARD_CLAIM: 'rank-reward-claim',
  MCP_TOKEN_MINUTE: 'mcp-token-min',
  MCP_TOKEN_DAY: 'mcp-token-day',
  MCP_IP_MINUTE: 'mcp-ip-min',
  MCP_TOKEN_CREATE: 'mcp-token-create',
  ADMIN_INVITATION_ACCEPT_IP: 'admin-invitation-accept-ip',
} as const;

export type RateLimitKeyPrefix = (typeof RATE_LIMIT_KEYS)[keyof typeof RATE_LIMIT_KEYS];

export type RateLimitKey = `${RateLimitKeyPrefix}:${string}`;

export function makeRateLimitKey(prefix: RateLimitKeyPrefix, id: string): RateLimitKey {
  return `${prefix}:${id}`;
}

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  onUnavailable?: 'allow' | 'deny';
};

export type RateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
  unavailable?: boolean;
};

export type RateLimiterAdapter<Key extends string = string> = {
  consume(key: Key, opts: RateLimitOptions): Promise<RateLimitResult>;
  reset(key: Key): Promise<void>;
};

export const RATE_LIMITER: Token<RateLimiterAdapter<RateLimitKey>> = createToken('RATE_LIMITER');

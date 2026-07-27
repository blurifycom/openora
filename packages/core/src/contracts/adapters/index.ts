// @openora/core/contracts - the single home for vendor adapter interfaces (the swap
// seams). A module's service depends on an adapter interface; an operator binds
// a concrete implementation to its DI token in the module's plugin.ts. One file
// per service category. See AGENTS.md "third-party integration" in the decision tree.

export type { AnyToken, Token, SealedToken, ClientPageToken } from './token.js';
export { createToken, createSealedToken, createClientPageToken } from './token.js';

export type {
  EventEnvelope,
  MessageBrokerAdapter,
  BrokerHandler,
  SubscribeOptions,
} from './broker.js';
export { MESSAGE_BROKER } from './broker.js';

export type { OutboxWriter } from './outbox.js';
export { OUTBOX } from './outbox.js';

export type {
  WalletCommands,
  WalletDebitArgs,
  WalletDebitOutcome,
  WalletCreditArgs,
  WalletCreditOutcome,
} from './wallet-commands.js';
export { WALLET_COMMANDS } from './wallet-commands.js';

export type { WalletReader } from './wallet-reader.js';
export { WALLET_READER } from './wallet-reader.js';

export type { IdentityReader } from './identity-reader.js';
export { IDENTITY_READER } from './identity-reader.js';

export type {
  JobQueueAdapter,
  QueueName,
  BackoffStrategy,
  EnqueueOptions,
  RepeatOptions,
  JobContext,
  JobHandler,
  WorkerOptions,
  WorkerRegistration,
  PayloadSchema,
} from './job-queue.js';
export { JOB_QUEUE, queue } from './job-queue.js';

export type {
  RateLimiterAdapter,
  RateLimitOptions,
  RateLimitResult,
  RateLimitKey,
  RateLimitKeyPrefix,
} from './rate-limit.js';
export { RATE_LIMITER, RATE_LIMIT_KEYS, makeRateLimitKey } from './rate-limit.js';

export type { CacheAdapter } from './cache.js';
export { CACHE } from './cache.js';

export type {
  RealtimeTransport,
  RealtimePresence,
  RealtimeConnectionGrant,
  RealtimeClientAuthorizer,
  RealtimeClientAuthorizerInput,
} from './realtime.js';
export { REALTIME_TRANSPORT, REALTIME_CLIENT_AUTHORIZER } from './realtime.js';

export type { GameAdapter } from './game.js';
export { GAME_ADAPTER } from './game.js';

export type {
  KycAdapter,
  KycVendorStatus,
  KycDocument,
  KycResult,
  KycStatusWriter,
  KycStatusSource,
  KycWebhookVerifier,
} from './kyc.js';
export { KYC_ADAPTER, KYC_STATUS_WRITER, KYC_WEBHOOK_VERIFIER } from './kyc.js';

export type { PaymentAdapter, PaymentWebhookEvent, PaymentWebhookVerifier } from './payment.js';
export { PAYMENT_ADAPTER, PAYMENT_WEBHOOK_VERIFIER } from './payment.js';

export type { GeoIpAdapter } from './geo-ip.js';
export { GEO_IP_ADAPTER } from './geo-ip.js';

export type { NotificationDeliveryAdapter } from './notification.js';
export { NOTIFICATION_DELIVERY_ADAPTER } from './notification.js';

export type { AggregatorAdapter, AggregatorGame, AggregatorWebhookVerifier } from './aggregator.js';
export { AGGREGATOR_ADAPTER, AGGREGATOR_WEBHOOK_VERIFIER } from './aggregator.js';

export type { RngAdapter } from './rng.js';
export { RNG_ADAPTER } from './rng.js';

export type { SendEmailPort } from './email.js';
export { SEND_EMAIL } from './email.js';

export type { SmsAdapter } from './sms.js';
export { SMS_ADAPTER } from './sms.js';
export type {
  EmailTemplateKey,
  EmailTemplateData,
  EmailTemplateRenderer,
} from './email-template.js';
export { EMAIL_TEMPLATE_RENDERER, DEFAULT_EMAIL_TEMPLATES } from './email-template.js';

export type { ErrorTrackingAdapter, ErrorContext } from './error-tracking.js';
export { ERROR_TRACKING } from './error-tracking.js';

export type { AdminGrant, AdminPermissionResolver } from './admin-permission.js';
export { ADMIN_PERMISSION_RESOLVER } from './admin-permission.js';

export type { AuditWritePort, AuditAction, DirectAuditAction } from './audit.js';
export { AUDIT_WRITER } from './audit.js';

export type { PlayerTags } from './player-tags.js';
export { PLAYER_TAGS } from './player-tags.js';

export type {
  AdminUserRow,
  AdminUserListOptions,
  AdminUserDirectory,
  AdminPlayerSummary,
  AdminUserSortBy,
} from './admin-user-directory.js';
export { ADMIN_USER_DIRECTORY, ADMIN_USER_SORT_BY_VALUES } from './admin-user-directory.js';

export type {
  AdminTxRow,
  AdminTxDetail,
  AdminTxListOptions,
  AdminWalletReporting,
  AdminTxSortBy,
} from './admin-wallet-reporting.js';
export { ADMIN_WALLET_REPORTING, ADMIN_TX_SORT_BY_VALUES } from './admin-wallet-reporting.js';

export type {
  IdentityServiceOptions,
  IdentityLockoutOptions,
  SessionCommands,
} from './identity.js';
export { IDENTITY_OPTIONS, SESSION_COMMANDS } from './identity.js';

export type { LoginEnforcementPort } from './login-enforcement.js';
export { LOGIN_ENFORCEMENT } from './login-enforcement.js';
export type { PlayEligibilityPort } from './play-eligibility.js';
export { PLAY_ELIGIBILITY } from './play-eligibility.js';

export type { ChatSystemMessage, ChatSystemWriter } from './chat-system-writer.js';
export { CHAT_SYSTEM_WRITER } from './chat-system-writer.js';

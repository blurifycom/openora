// @blurifycom/core/contracts - the single home for vendor adapter interfaces (the swap
// seams). A module's service depends on an adapter interface; an operator binds
// a concrete implementation to its DI token in the module's plugin.ts. One file
// per service category. See AGENTS.md "third-party integration" in the decision tree.

export type { Token, SealedToken, ClientPageToken } from './token.js';
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

export type { WalletCommands, WalletDebitArgs, WalletDebitOutcome } from './wallet-commands.js';
export { WALLET_COMMANDS } from './wallet-commands.js';

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
  RealtimeTransport,
  RealtimePresence,
  RealtimeConnectionGrant,
  RealtimeClientAuthorizer,
  RealtimeClientAuthorizerInput,
} from './realtime.js';
export { REALTIME_TRANSPORT, REALTIME_CLIENT_AUTHORIZER } from './realtime.js';

export type { GameAdapter } from './game.js';
export { GAME_ADAPTER } from './game.js';

export type { KycAdapter, KycVendorStatus, KycDocument, KycResult } from './kyc.js';
export { KYC_ADAPTER } from './kyc.js';

export type { PaymentAdapter } from './payment.js';
export { PAYMENT_ADAPTER } from './payment.js';

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

export type { AdminGrant, AdminPermissionResolver } from './admin-permission.js';
export { ADMIN_PERMISSION_RESOLVER } from './admin-permission.js';

export type { AuditWritePort } from './audit.js';
export { AUDIT_WRITER } from './audit.js';

export type {
  AdminUserRow,
  AdminUserListOptions,
  AdminUserDirectory,
} from './admin-user-directory.js';
export { ADMIN_USER_DIRECTORY } from './admin-user-directory.js';

export type {
  AdminTxRow,
  AdminTxListOptions,
  AdminWalletReporting,
} from './admin-wallet-reporting.js';
export { ADMIN_WALLET_REPORTING } from './admin-wallet-reporting.js';

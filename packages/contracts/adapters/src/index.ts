// @oss/adapters - the single home for vendor adapter interfaces (the swap
// seams). A module's service depends on an adapter interface; an operator binds
// a concrete implementation to its DI token in the module's plugin.ts. One file
// per service category. See AGENTS.md "third-party integration" in the decision tree.

export type { Token, SealedToken, ClientPageToken } from './token.js';
export { createToken, createSealedToken, createClientPageToken } from './token.js';

export type { MessageBrokerAdapter, BrokerHandler } from './broker.js';
export { MESSAGE_BROKER } from './broker.js';

export type { GameAdapter } from './game.js';
export { GAME_ADAPTER } from './game.js';

export type { KycAdapter, KycStatus, KycDocument, KycResult } from './kyc.js';
export { KYC_ADAPTER } from './kyc.js';

export type { PaymentAdapter } from './payment.js';
export { PAYMENT_ADAPTER } from './payment.js';

export type { GeoIpAdapter } from './geo-ip.js';
export { GEO_IP_ADAPTER } from './geo-ip.js';

export type { NotificationDeliveryAdapter } from './notification.js';
export { NOTIFICATION_DELIVERY_ADAPTER } from './notification.js';

export type { AggregatorAdapter, AggregatorGame } from './aggregator.js';
export { AGGREGATOR_ADAPTER } from './aggregator.js';

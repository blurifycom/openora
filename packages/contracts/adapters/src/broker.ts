// Message-broker seam. The EventBus (@oss/core) publishes/subscribes through this
// adapter, so the inter-module transport is swappable: the default binding is an
// in-process broker; a downstream operator binds a durable driver (Redpanda /
// Kafka API, NATS JetStream, RabbitMQ) to MESSAGE_BROKER in an overlay and every
// event flows through it - no module change. Delivery is at-least-once once a real
// broker is bound, so consumers must be idempotent. See ADR-0010.
import { createToken, type Token } from './token.js';

export type BrokerHandler = (payload: unknown) => void | Promise<void>;

export interface MessageBrokerAdapter {
  publish(topic: string, payload: unknown): void | Promise<void>;
  subscribe(topic: string, handler: BrokerHandler): void;
}

export const MESSAGE_BROKER: Token<MessageBrokerAdapter> = createToken('MESSAGE_BROKER');

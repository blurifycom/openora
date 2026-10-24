/**
 * Message-broker seam. The EventBus (@openora/core/server) publishes/subscribes through this
 * adapter, so the inter-module transport is swappable: the default binding is an
 * in-process broker; a downstream operator binds a durable driver (RabbitMQ,
 * Redpanda / Kafka API, NATS JetStream) to MESSAGE_BROKER in an overlay and every
 * event flows through it - no module change. Delivery is at-least-once once a real
 * broker is bound, so consumers must be idempotent. See ADR-0010 and ADR-0016.
 */
import { createToken, type Token } from './token.js';

/**
 * On-the-wire envelope that every remote adapter serializes. The EventBus
 * builds this internally; module code never sees it (only the typed payload).
 */
export type EventEnvelope<T = unknown> = {
  /** Consumer-side idempotency/dedup key (UUID per emission). */
  eventId: string;
  /** Domain event name (eg "wallet.deposit.completed"). */
  topic: string;
  /** The validated event payload (matches domainEventSchemas). */
  payload: T;
  /** ISO-8601 timestamp of the emission. */
  occurredAt: string;
  /** Monotonic integer for forward-compat payload evolution. */
  schemaVersion: number;
  /** Maps to Kafka partition key / RabbitMQ routing key for per-user ordering guarantees. */
  orderingKey?: string;
  /** Distributed trace correlation ID. */
  traceId?: string;
};

export type BrokerHandler = (envelope: EventEnvelope) => void | Promise<void>;

export type SubscribeOptions = {
  /**
   * Overrides the consumer group (Kafka consumer group / RabbitMQ queue group). `EventBus`
   * never sets it, so module handlers join the deployment's group - `SERVICE_NAME` in the
   * Redis Streams driver - and each event reaches one replica per service.
   */
  consumerGroup?: string;
};

export type MessageBrokerAdapter = {
  publish(envelope: EventEnvelope): void | Promise<void>;
  subscribe(topic: string, handler: BrokerHandler, options?: SubscribeOptions): () => void;
  close(): Promise<void>;
};

export const MESSAGE_BROKER: Token<MessageBrokerAdapter> = createToken('MESSAGE_BROKER');

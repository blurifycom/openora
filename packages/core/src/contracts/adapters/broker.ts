import { createToken, type Token } from './token.js';

export type EventEnvelope<T = unknown> = {
  eventId: string;
  topic: string;
  payload: T;
  occurredAt: string;
  schemaVersion: number;
  orderingKey?: string;
  traceId?: string;
  correlationId?: string;
};

export type BrokerHandler = (envelope: EventEnvelope) => void | Promise<void>;

export type SubscribeOptions = {
  consumerGroup?: string;
};

export type MessageBrokerAdapter = {
  publish(envelope: EventEnvelope): void | Promise<void>;
  subscribe(topic: string, handler: BrokerHandler, options?: SubscribeOptions): () => void;
  close(): Promise<void>;
  deadLetters?(): Promise<DeadLetters>;
};

export type DeadLetters = { count: number; newest: string | null };

export const MESSAGE_BROKER: Token<MessageBrokerAdapter> = createToken('MESSAGE_BROKER');

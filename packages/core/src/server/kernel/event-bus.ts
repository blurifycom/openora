import {
  createToken,
  type Token,
  type MessageBrokerAdapter,
  type OutboxWriter,
  type EventEnvelope,
  domainEventSchemas,
  getEventVersion,
  type DomainEventName,
  type DomainEventPayload,
} from '@openora/core/contracts';
import type { ZodType } from 'zod';
import type { Logger } from 'pino';
import { createLogger } from './logger.js';
import {
  getCurrentCorrelationId,
  getCurrentTraceId,
  notePublishedTopic,
} from './request-context.js';

export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type EventHandler<T = unknown> = (
  payload: T,
  envelope?: EventEnvelope,
) => void | Promise<void>;

export type SubscribeHandlerOptions = {
  consumer?: string;
  consumerGroup?: string;
};

export type ProcessedEventLog = {
  has(eventId: string, consumer: string): Promise<boolean>;
  record(eventId: string, consumer: string): Promise<void>;
};

export type EventBus = {
  emit<K extends DomainEventName>(event: K, payload: DomainEventPayload<K>): void;
  emitRaw(event: string, payload: unknown): void;
  emitInTransaction<K extends DomainEventName>(
    tx: unknown,
    event: K,
    payload: DomainEventPayload<K>,
  ): Promise<void>;
  on<K extends DomainEventName>(
    event: K,
    handler: EventHandler<DomainEventPayload<K>>,
    options?: SubscribeHandlerOptions,
  ): () => void;
  on(event: string, handler: EventHandler, options?: SubscribeHandlerOptions): () => void;
  tapTransactional(tap: TransactionalTap): void;
};

type TransactionalTap = (tx: unknown, envelope: EventEnvelope) => Promise<void>;

export const EVENT_BUS: Token<EventBus> = createToken('EVENT_BUS');

export type EventBusDeps = {
  broker: MessageBrokerAdapter;
  outbox: OutboxWriter;
  processedEvents: ProcessedEventLog;
  logger?: Logger;
};

function isKnownEvent(event: string): event is DomainEventName {
  return event in domainEventSchemas;
}

function buildEnvelope(event: string, payload: unknown): EventEnvelope {
  const traceId = getCurrentTraceId();
  const correlationId = getCurrentCorrelationId();
  return {
    eventId: crypto.randomUUID(),
    topic: event,
    payload,
    occurredAt: new Date().toISOString(),
    schemaVersion: getEventVersion(event),
    ...(traceId !== undefined ? { traceId } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
}

function parseKnownPayload(event: string, payload: unknown): unknown {
  if (!isKnownEvent(event)) {
    return payload;
  }
  const schema = domainEventSchemas[event] as ZodType<unknown>;
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error(`Event '${event}' payload failed validation: ${result.error.message}`);
  }
  return result.data;
}

export function createEventBus({
  broker,
  outbox,
  processedEvents,
  logger = createLogger('event-bus'),
}: EventBusDeps): EventBus {
  function publishEvent(event: string, payload: unknown): void {
    parseKnownPayload(event, payload);
    notePublishedTopic(event);
    const envelope = buildEnvelope(event, payload);
    void Promise.resolve(broker.publish(envelope)).catch((err) =>
      logger.error({ event, err }, 'event publish failed'),
    );
  }

  const taps: TransactionalTap[] = [];

  return {
    emit(event, payload) {
      publishEvent(event, payload);
    },

    emitRaw(event, payload) {
      publishEvent(event, payload);
    },

    async emitInTransaction(tx: unknown, event: string, payload: unknown): Promise<void> {
      const parsed = parseKnownPayload(event, payload);
      notePublishedTopic(event);
      const envelope = buildEnvelope(event, payload);
      await outbox.write(tx, envelope);
      for (const tap of taps) {
        await tap(tx, { ...envelope, payload: parsed });
      }
    },

    tapTransactional(tap) {
      taps.push(tap);
    },

    on(event: string, handler: EventHandler, options?: SubscribeHandlerOptions): () => void {
      const consumer = options?.consumer;
      const consumerGroup = options?.consumerGroup;
      const onEnvelope = async (envelope: EventEnvelope) => {
        if (consumer && (await processedEvents.has(envelope.eventId, consumer))) {
          return;
        }
        try {
          const payload = parseKnownPayload(event, envelope.payload);
          const delivered = payload === envelope.payload ? envelope : { ...envelope, payload };
          await handler(payload, delivered);
        } catch (err) {
          logger.error(
            { event, consumer, eventId: envelope.eventId, err },
            'event subscriber threw',
          );
          throw err;
        }
        if (consumer) {
          await processedEvents.record(envelope.eventId, consumer);
        }
      };
      return consumerGroup
        ? broker.subscribe(event, onEnvelope, { consumerGroup })
        : broker.subscribe(event, onEnvelope);
    },
  };
}

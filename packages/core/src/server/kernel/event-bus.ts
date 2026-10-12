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
import { getCurrentTraceId } from './request-context.js';

// How long a published event stays redeliverable: the Redis Streams retention, and the
// age past which outbox and processed_events rows are pruned. See ADR-0044.
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type EventHandler<T = unknown> = (
  payload: T,
  envelope?: EventEnvelope,
) => void | Promise<void>;

export type SubscribeHandlerOptions = {
  // Stable identity of this handler across restarts and replicas. When set, a
  // redelivered event skips the handler once it has succeeded for that event.
  consumer?: string;
};

// Records which (eventId, consumer) pairs already ran to completion. A port so the
// kernel stays ORM-free; the Drizzle implementation lives next to the outbox.
export type ProcessedEventLog = {
  has(eventId: string, consumer: string): Promise<boolean>;
  record(eventId: string, consumer: string): Promise<void>;
};

// Typed app-facing event API. Services depend on this, never on the broker directly.
// The optional second arg to handlers exposes the full envelope; existing (payload)-only
// handlers continue to work unchanged.
export type EventBus = {
  // Best-effort, post-commit fan-out: the publish is fire-and-forget, so a broker
  // outage loses the event. For informational and cache-invalidation events only.
  // Throws synchronously when a known event's payload fails its schema.
  emit<K extends DomainEventName>(event: K, payload: DomainEventPayload<K>): void;
  // Escape hatch for plugin-defined dynamic topics not in domainEventSchemas.
  emitRaw(event: string, payload: unknown): void;
  // Durable, transaction-atomic emit. Call INSIDE a db.transaction, passing the
  // transaction handle: the envelope is written to the outbox within `tx` and the
  // OutboxRelay publishes it after commit, so the event exists if and only if the
  // state change committed. Required for anything that reports a committed change on
  // a money or compliance path. Rejects (rolling `tx` back) on an invalid payload.
  emitInTransaction<K extends DomainEventName>(
    tx: unknown,
    event: K,
    payload: DomainEventPayload<K>,
  ): Promise<void>;
  // A handler that throws is retried by the broker and dead-lettered after repeated
  // failures (see RedisStreamsBroker), so it must be idempotent.
  on<K extends DomainEventName>(
    event: K,
    handler: EventHandler<DomainEventPayload<K>>,
    options?: SubscribeHandlerOptions,
  ): () => void;
  on(event: string, handler: EventHandler, options?: SubscribeHandlerOptions): () => void;
};

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
  return {
    eventId: crypto.randomUUID(),
    topic: event,
    payload,
    occurredAt: new Date().toISOString(),
    schemaVersion: getEventVersion(event),
    ...(traceId !== undefined ? { traceId } : {}),
  };
}

// Applies a known event's schema (defaults included); throws when the payload fails it.
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

/** Typed facade over a MessageBrokerAdapter: validates payloads, builds the envelope, dedups handlers. */
export function createEventBus({
  broker,
  outbox,
  processedEvents,
  logger = createLogger('event-bus'),
}: EventBusDeps): EventBus {
  function publishEvent(event: string, payload: unknown): void {
    parseKnownPayload(event, payload);
    const envelope = buildEnvelope(event, payload);
    void Promise.resolve(broker.publish(envelope)).catch((err) =>
      logger.error({ event, err }, 'event publish failed'),
    );
  }

  return {
    emit(event, payload) {
      publishEvent(event, payload);
    },

    emitRaw(event, payload) {
      publishEvent(event, payload);
    },

    async emitInTransaction(tx: unknown, event: string, payload: unknown): Promise<void> {
      parseKnownPayload(event, payload);
      await outbox.write(tx, buildEnvelope(event, payload));
    },

    on(event: string, handler: EventHandler, options?: SubscribeHandlerOptions): () => void {
      const consumer = options?.consumer;
      return broker.subscribe(event, async (envelope: EventEnvelope) => {
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
      });
    },
  };
}

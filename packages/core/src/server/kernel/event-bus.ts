import {
  createToken,
  type Token,
  type MessageBrokerAdapter,
  type OutboxWriter,
  type EventEnvelope,
  type SubscribeOptions,
  type ErrorTrackingAdapter,
  domainEventSchemas,
  getEventVersion,
  type DomainEventName,
  type DomainEventPayload,
} from '@openora/core/contracts';
import type { ZodType } from 'zod';
import type { Logger } from 'pino';
import { createLogger } from './logger.js';
import { getCurrentTraceId } from './request-context.js';

export type EventHandler<T = unknown> = (
  payload: T,
  envelope?: EventEnvelope,
) => void | Promise<void>;

// Typed app-facing event API. Services depend on this, never on the broker directly.
// The optional second arg to handlers exposes the full envelope; existing (payload)-only
// handlers continue to work unchanged.
export type EventBus = {
  emit<K extends DomainEventName>(event: K, payload: DomainEventPayload<K>): void;
  emit(event: string, payload: unknown): void;
  // Durable, transaction-atomic emit. Call INSIDE a db.transaction, passing the
  // transaction handle, when the event must never be lost relative to its state
  // change (money, anything a separate service depends on). The envelope is
  // written to the outbox within `tx`; a relay publishes it after commit. Requires
  // the outbox to be bound (OUTBOX_ENABLED / a durable broker) - otherwise throws,
  // so a money path can't silently degrade to best-effort delivery. Prefer this
  // over emit() for cross-service-critical events; emit() stays for best-effort
  // post-commit fan-out within a single process.
  emitInTransaction<K extends DomainEventName>(
    tx: unknown,
    event: K,
    payload: DomainEventPayload<K>,
  ): Promise<void>;
  emitInTransaction(tx: unknown, event: string, payload: unknown): Promise<void>;
  on<K extends DomainEventName>(event: K, handler: EventHandler<DomainEventPayload<K>>): () => void;
  on(event: string, handler: EventHandler): () => void;
};

export const EVENT_BUS: Token<EventBus> = createToken('EVENT_BUS');

/**
 * Default in-process `MESSAGE_BROKER` - `publish` fans out synchronously to
 * whatever's subscribed in THIS process only; it does not survive a restart
 * and does not reach other replicas. An overlay rebinds `MESSAGE_BROKER` to a
 * durable `MessageBrokerAdapter` (eg RabbitMQ via `AMQP_URL`) once events must
 * cross a process boundary. `subscribe`'s returned unsubscribe function is
 * safe to call mid-dispatch: the handler list is copied on write, never
 * mutated in place.
 */
export class InMemoryBroker implements MessageBrokerAdapter {
  private readonly handlers = new Map<
    string,
    Array<(env: EventEnvelope) => void | Promise<void>>
  >();

  publish(envelope: EventEnvelope): void {
    for (const fn of this.handlers.get(envelope.topic) ?? []) {
      void fn(envelope);
    }
  }

  subscribe(
    topic: string,
    handler: (env: EventEnvelope) => void | Promise<void>,
    _options?: SubscribeOptions,
  ): () => void {
    const fns = this.handlers.get(topic) ?? [];
    const updated = [...fns, handler];
    this.handlers.set(topic, updated);
    return () => {
      const current = this.handlers.get(topic) ?? [];
      this.handlers.set(
        topic,
        current.filter((f) => f !== handler),
      );
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

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

/** Typed facade over a MessageBrokerAdapter. Validates known payloads, isolates subscriber failures, and builds the envelope. */
export function createEventBus(
  broker: MessageBrokerAdapter,
  logger: Logger = createLogger('event-bus'),
  outbox?: OutboxWriter,
  reporter?: ErrorTrackingAdapter,
): EventBus {
  function validate(event: string, payload: unknown): void {
    if (isKnownEvent(event)) {
      const schema = domainEventSchemas[event] as ZodType<unknown>;
      const result = schema.safeParse(payload);
      if (!result.success) {
        // Log loudly but still deliver - a schema lag must not silently drop events.
        logger.error({ event, issues: result.error.issues }, 'event payload failed validation');
      }
    }
  }

  return {
    emit(event: string, payload: unknown): void {
      validate(event, payload);
      const envelope = buildEnvelope(event, payload);
      void broker.publish(envelope);
    },

    async emitInTransaction(tx: unknown, event: string, payload: unknown): Promise<void> {
      if (!outbox) {
        throw new Error(
          `emitInTransaction('${event}') requires the transactional outbox, which is not bound. ` +
            `Enable it (set OUTBOX_ENABLED=1 or a durable broker via AMQP_URL) so the event is ` +
            `published reliably, or use emit() for best-effort post-commit delivery.`,
        );
      }
      validate(event, payload);
      await outbox.write(tx, buildEnvelope(event, payload));
    },

    on(event: string, handler: EventHandler): () => void {
      return broker.subscribe(event, async (envelope: EventEnvelope) => {
        try {
          await handler(envelope.payload, envelope);
        } catch (err) {
          logger.error({ event, err }, 'event subscriber threw');
          reporter?.captureException(err, {
            traceId: getCurrentTraceId(),
            tags: { event, path: 'event-subscriber' },
          });
        }
      });
    },
  };
}

import {
  createToken,
  type Token,
  type MessageBrokerAdapter,
  type EventEnvelope,
  type SubscribeOptions,
} from '@oss/adapters';
import {
  domainEventSchemas,
  type DomainEventName,
  type DomainEventPayload,
} from '@oss/shared-schemas';
import type { ZodType } from 'zod';
import type { Logger } from 'pino';
import { createLogger } from './logger.js';
import { getCurrentTenant } from './tenant-context.js';

export type EventHandler<T = unknown> = (
  payload: T,
  envelope?: EventEnvelope,
) => void | Promise<void>;

// Typed app-facing event API. Known events (in the shared-schemas catalog) are
// payload-checked at compile time; the string overload stays open for events an
// overlay or consumer defines. Services depend on this - never on the broker.
// The optional second argument to handlers exposes the full envelope (eventId,
// tenantId, traceId, orderingKey) to callers that need it; existing handlers
// that only accept (payload) continue to work unchanged.
export interface EventBus {
  emit<K extends DomainEventName>(event: K, payload: DomainEventPayload<K>): void;
  emit(event: string, payload: unknown): void;
  on<K extends DomainEventName>(event: K, handler: EventHandler<DomainEventPayload<K>>): void;
  on(event: string, handler: EventHandler): void;
}

export const EVENT_BUS: Token<EventBus> = createToken('EVENT_BUS');

// Default in-process transport: synchronous fan-out via a topic->handlers map.
// Swap by binding a durable MessageBrokerAdapter to MESSAGE_BROKER in an overlay.
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
  const tenant = getCurrentTenant();
  return {
    eventId: crypto.randomUUID(),
    topic: event,
    payload,
    occurredAt: new Date().toISOString(),
    schemaVersion: 1,
    ...(tenant?.tenantId !== undefined ? { tenantId: tenant.tenantId } : {}),
    ...(tenant?.traceId !== undefined ? { traceId: tenant.traceId } : {}),
  };
}

// Typed facade over a MessageBrokerAdapter. Single responsibility: validate known
// payloads against the catalog, isolate subscriber failures (one throwing handler
// never breaks the emitter or its siblings), build the envelope, and delegate
// delivery to the broker. Module handlers receive (payload, envelope?) - the
// envelope is optional so no existing handler signature breaks.
export function createEventBus(
  broker: MessageBrokerAdapter,
  logger: Logger = createLogger('event-bus'),
): EventBus {
  return {
    emit(event: string, payload: unknown): void {
      if (isKnownEvent(event)) {
        const schema = domainEventSchemas[event] as ZodType<unknown>;
        const result = schema.safeParse(payload);
        if (!result.success) {
          // Log loudly but still deliver - a schema lag must not silently drop events.
          logger.error({ event, issues: result.error.issues }, 'event payload failed validation');
        }
      }
      const envelope = buildEnvelope(event, payload);
      void broker.publish(envelope);
    },

    on(event: string, handler: EventHandler): void {
      broker.subscribe(event, async (envelope: EventEnvelope) => {
        try {
          await handler(envelope.payload, envelope);
        } catch (err) {
          logger.error({ event, err }, 'event subscriber threw');
        }
      });
    },
  };
}

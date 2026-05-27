import {
  createToken,
  type Token,
  type MessageBrokerAdapter,
  type BrokerHandler,
} from '@oss/adapters';
import {
  domainEventSchemas,
  type DomainEventName,
  type DomainEventPayload,
} from '@oss/shared-schemas';
import type { ZodType } from 'zod';
import type { Logger } from 'pino';
import { createLogger } from './logger.js';

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

// Typed app-facing event API. Known events (in the shared-schemas catalog) are
// payload-checked at compile time; the string overload stays open for events an
// overlay or consumer defines. Services depend on this - never on the broker.
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
  private readonly handlers = new Map<string, BrokerHandler[]>();

  publish(topic: string, payload: unknown): void {
    for (const fn of this.handlers.get(topic) ?? []) {
      void fn(payload);
    }
  }

  subscribe(topic: string, handler: BrokerHandler): void {
    const fns = this.handlers.get(topic) ?? [];
    this.handlers.set(topic, [...fns, handler]);
  }
}

function isKnownEvent(event: string): event is DomainEventName {
  return event in domainEventSchemas;
}

// Typed facade over a MessageBrokerAdapter. Single responsibility: validate known
// payloads against the catalog, isolate subscriber failures (one throwing handler
// never breaks the emitter or its siblings), and delegate delivery to the broker.
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
      void broker.publish(event, payload);
    },

    on(event: string, handler: EventHandler): void {
      broker.subscribe(event, async (payload) => {
        try {
          await handler(payload);
        } catch (err) {
          logger.error({ event, err }, 'event subscriber threw');
        }
      });
    },
  };
}

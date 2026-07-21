import type {
  MessageBrokerAdapter,
  EventEnvelope,
  SubscribeOptions,
} from '@openora/core/contracts';

/**
 * Test-only `MESSAGE_BROKER` double - `publish` fans out synchronously to
 * whatever's subscribed in THIS process only; it does not survive a restart
 * and does not reach other replicas. Production requires a durable
 * `MessageBrokerAdapter` overlay instead (`createApp` throws otherwise -
 * `assertDurableSeamsBound`). `subscribe`'s returned unsubscribe function is
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

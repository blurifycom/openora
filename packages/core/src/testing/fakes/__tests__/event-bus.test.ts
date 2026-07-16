import { describe, it, expect, vi } from 'vitest';
import type { EventEnvelope } from '@openora/core/contracts';
import { InMemoryBroker } from '../event-bus.js';

function envelope(topic: string, payload: unknown): EventEnvelope {
  return {
    eventId: crypto.randomUUID(),
    topic,
    payload,
    occurredAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

function collector() {
  const seen: EventEnvelope[] = [];
  return { seen, handler: (env: EventEnvelope) => void seen.push(env) };
}

describe('InMemoryBroker', () => {
  it('fans a published envelope out to every subscriber of the topic', () => {
    const broker = new InMemoryBroker();
    const a = collector();
    const b = collector();
    broker.subscribe('t', a.handler);
    broker.subscribe('t', b.handler);
    broker.publish(envelope('t', { v: 1 }));
    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(1);
  });

  it('does not deliver across topics', () => {
    const broker = new InMemoryBroker();
    const { seen, handler } = collector();
    broker.subscribe('one', handler);
    broker.publish(envelope('two', { v: 1 }));
    expect(seen).toHaveLength(0);
  });

  it('stops delivering after the returned unsubscribe runs', () => {
    const broker = new InMemoryBroker();
    const { seen, handler } = collector();
    const unsubscribe = broker.subscribe('t', handler);
    broker.publish(envelope('t', { v: 1 }));
    unsubscribe();
    broker.publish(envelope('t', { v: 2 }));
    expect(seen).toHaveLength(1);
  });

  it('close() clears every handler', async () => {
    const broker = new InMemoryBroker();
    const handler = vi.fn();
    broker.subscribe('t', handler);
    await broker.close();
    broker.publish(envelope('t', { v: 1 }));
    expect(handler).not.toHaveBeenCalled();
  });
});

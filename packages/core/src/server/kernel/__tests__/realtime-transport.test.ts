import { describe, it, expect } from 'vitest';
import { InProcessRealtimeTransport } from '../realtime-transport.js';
import { runRealtimeTransportConformanceSuite } from '../../../testing/realtime-transport-conformance.js';

runRealtimeTransportConformanceSuite({
  name: 'InProcessRealtimeTransport',
  create: () => new InProcessRealtimeTransport(),
  supportsServerSideSubscribe: true,
  addPresence: (transport, channel, entries) => {
    for (const { userId, connectionId } of entries) {
      transport.presence?.join(channel, userId, connectionId);
    }
  },
});

describe('InProcessRealtimeTransport', () => {
  it('fans a published event out to every subscriber of the channel', () => {
    const t = new InProcessRealtimeTransport();
    const a: number[] = [];
    const b: number[] = [];
    t.subscribe<number>('c', (e) => a.push(e));
    t.subscribe<number>('c', (e) => b.push(e));
    t.publish('c', 1);
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
  });

  it('does not deliver across channels', () => {
    const t = new InProcessRealtimeTransport();
    const got: number[] = [];
    t.subscribe<number>('one', (e) => got.push(e));
    t.publish('two', 99);
    expect(got).toEqual([]);
  });

  it('stops delivering after unsubscribe', () => {
    const t = new InProcessRealtimeTransport();
    const got: number[] = [];
    const unsub = t.subscribe<number>('c', (e) => got.push(e));
    t.publish('c', 1);
    unsub();
    t.publish('c', 2);
    expect(got).toEqual([1]);
  });

  it('isolates a throwing subscriber from the others', () => {
    const t = new InProcessRealtimeTransport();
    const got: number[] = [];
    t.subscribe<number>('c', () => {
      throw new Error('bad subscriber');
    });
    t.subscribe<number>('c', (e) => got.push(e));
    expect(() => t.publish('c', 7)).not.toThrow();
    expect(got).toEqual([7]);
  });

  it('tracks presence counts per channel', () => {
    const t = new InProcessRealtimeTransport();
    t.presence.join('room', 'u1', 'tab-1');
    t.presence.join('room', 'u2', 'tab-1');
    t.presence.join('room', 'u2', 'tab-2');
    expect(t.presence.count('room')).toBe(2);
    t.presence.leave('room', 'u2', 'tab-1');
    expect(t.presence.count('room')).toBe(2);
    t.presence.leave('room', 'u1', 'tab-1');
    expect(t.presence.count('room')).toBe(1);
  });
});

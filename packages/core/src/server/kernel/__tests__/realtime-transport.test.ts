import { describe, it, expect } from 'vitest';
import type { RealtimeSignal } from '@openora/core/contracts';
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
  it('fans a removal tombstone out through the same stream', () => {
    const t = new InProcessRealtimeTransport();
    const got: Array<{ id: string; isDeleted: boolean }> = [];
    t.subscribe('c', (event: { id: string; isDeleted: boolean }) => got.push(event));
    t.remove('c', { id: 'message-1', isDeleted: true });
    expect(got).toEqual([{ id: 'message-1', isDeleted: true }]);
  });

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

  it('notifies only the affected user before pruning every message and signal subscription', () => {
    const t = new InProcessRealtimeTransport();
    const channel = 'chat:room:private-room';
    const revokedUserId = 'revoked-user';
    const otherUserId = 'other-user';
    const firstMessages: string[] = [];
    const secondMessages: string[] = [];
    const otherMessages: string[] = [];
    const firstSignals: RealtimeSignal[] = [];
    const secondSignals: RealtimeSignal[] = [];
    const otherSignals: RealtimeSignal[] = [];

    t.subscribe<string>(channel, (event) => firstMessages.push(event), revokedUserId);
    t.subscribe<string>(channel, (event) => secondMessages.push(event), revokedUserId);
    t.subscribe<string>(channel, (event) => otherMessages.push(event), otherUserId);
    t.subscribeSignal(
      channel,
      (signal) => {
        firstSignals.push(signal);
        t.publish(channel, 'before-prune');
        throw new Error('disconnected');
      },
      revokedUserId,
    );
    t.subscribeSignal(channel, (signal) => secondSignals.push(signal), revokedUserId);
    t.subscribeSignal(channel, (signal) => otherSignals.push(signal), otherUserId);

    expect(() => t.revokeUserFromChannel(revokedUserId, channel)).not.toThrow();

    const revocationSignal = {
      name: 'chat:access-revoked',
      payload: { channel },
    };
    expect(firstSignals).toEqual([revocationSignal]);
    expect(secondSignals).toEqual([revocationSignal]);
    expect(otherSignals).toEqual([]);
    expect(firstMessages).toEqual(['before-prune']);
    expect(secondMessages).toEqual(['before-prune']);
    expect(otherMessages).toEqual(['before-prune']);

    t.publish(channel, 'after-prune');
    t.signal(channel, 'chat:room-changed', { channel });

    expect(firstMessages).toEqual(['before-prune']);
    expect(secondMessages).toEqual(['before-prune']);
    expect(otherMessages).toEqual(['before-prune', 'after-prune']);
    expect(firstSignals).toEqual([revocationSignal]);
    expect(secondSignals).toEqual([revocationSignal]);
    expect(otherSignals).toEqual([{ name: 'chat:room-changed', payload: { channel } }]);
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

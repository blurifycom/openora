import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ACCESS_REVOKED_SIGNAL,
  type RealtimeSignal,
  type RealtimeTransport,
} from '@openora/core/contracts';

export type RealtimeTransportHarness = {
  /** Used only in describe() block naming for readable output. */
  name: string;
  /** Every call returns an instance sharing one backend, the way two replicas would. */
  create: () => RealtimeTransport;
  /**
   * False for a transport whose subscribe() is a server-side no-op because
   * clients connect directly to a managed vendor's edge (eg AblyRealtimeTransport).
   * Gates the publish/subscribe fan-out assertions.
   */
  supportsServerSideSubscribe: boolean;
  /**
   * Seeds the harness's notion of "these users are online in this channel" so
   * getOnlineUserIds() can be asserted the same way across a transport that
   * tracks join/leave itself (in-process) and one that reads a vendor-side
   * presence set instead (Ably) - the entries stand in for real connections
   * regardless of how the transport backs them.
   */
  addPresence?: (
    transport: RealtimeTransport,
    channel: string,
    entries: { userId: string; connectionId: string }[],
  ) => void | Promise<void>;
  /**
   * Forces the harness's next presence/online-user call to fail, to assert
   * graceful degradation (never throws/rejects, returns a safe default).
   */
  simulateFailure?: (transport: RealtimeTransport) => void;
};

const SUBSCRIBE_SETTLE_MS = 200;
function settle(ms = SUBSCRIBE_SETTLE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared behavioral spec for every RealtimeTransport implementation. Run this
 * against each adapter alongside its own adapter-specific tests (this suite
 * doesn't replace those) - it only proves the two satisfy the SAME contract.
 */
export function runRealtimeTransportConformanceSuite(harness: RealtimeTransportHarness): void {
  describe(`RealtimeTransport conformance: ${harness.name}`, () => {
    it('publish never throws or rejects, even to a channel with no subscribers', async () => {
      const transport = harness.create();
      await expect(
        Promise.resolve(transport.publish('nobody-listening', { x: 1 })),
      ).resolves.toBeUndefined();
    });

    it('remove never throws or rejects, even to a channel with no subscribers', async () => {
      const transport = harness.create();
      await expect(
        Promise.resolve(transport.remove('nobody-listening', { id: 'message-1', isDeleted: true })),
      ).resolves.toBeUndefined();
    });

    it('subscribe returns an unsubscribe function that is idempotent', () => {
      const transport = harness.create();
      const unsubscribe = transport.subscribe('c', () => {});
      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
      expect(() => unsubscribe()).not.toThrow();
    });

    if (harness.supportsServerSideSubscribe) {
      it('fans a published event out to every subscriber of the channel', async () => {
        const transport = harness.create();
        const a: number[] = [];
        const b: number[] = [];
        transport.subscribe<number>('c', (event) => a.push(event));
        transport.subscribe<number>('c', (event) => b.push(event));
        await settle();

        await transport.publish('c', 1);
        await vi.waitFor(() => {
          expect(a).toEqual([1]);
          expect(b).toEqual([1]);
        });
      });

      it('does not deliver across channels', async () => {
        const transport = harness.create();
        const got: number[] = [];
        transport.subscribe<number>('one', (event) => got.push(event));
        await settle();

        await transport.publish('two', 99);
        await settle();
        expect(got).toEqual([]);
      });

      it('stops delivering after unsubscribe', async () => {
        const transport = harness.create();
        const got: number[] = [];
        const unsubscribe = transport.subscribe<number>('c', (event) => got.push(event));
        await settle();

        await transport.publish('c', 1);
        await vi.waitFor(() => expect(got).toEqual([1]));

        unsubscribe();
        await settle();
        await transport.publish('c', 2);
        await settle();
        expect(got).toEqual([1]);
      });

      it('revoking on one instance signals and cuts only that user on a sibling instance', async (ctx) => {
        const origin = harness.create();
        const sibling = harness.create();
        if (!origin.revokeUserFromChannel || !origin.signal || !sibling.subscribeSignal) {
          ctx.skip();
          return;
        }
        const channel = `chat:room:${randomUUID()}`;
        const revokedMessages: unknown[] = [];
        const revokedSignals: RealtimeSignal[] = [];
        const throwingSignals: RealtimeSignal[] = [];
        const otherMessages: unknown[] = [];
        const otherSignals: RealtimeSignal[] = [];
        sibling.subscribe(channel, (event) => revokedMessages.push(event), 'revoked-user');
        sibling.subscribeSignal(
          channel,
          (signal) => {
            throwingSignals.push(signal);
            throw new Error('disconnected');
          },
          'revoked-user',
        );
        sibling.subscribeSignal(channel, (signal) => revokedSignals.push(signal), 'revoked-user');
        sibling.subscribe(channel, (event) => otherMessages.push(event), 'other-user');
        sibling.subscribeSignal(channel, (signal) => otherSignals.push(signal), 'other-user');
        await settle();

        await origin.revokeUserFromChannel('revoked-user', channel);
        const revocation = { name: ACCESS_REVOKED_SIGNAL, payload: { channel } };
        await vi.waitFor(() => {
          expect(revokedSignals).toEqual([revocation]);
          expect(throwingSignals).toEqual([revocation]);
        });

        await origin.publish(channel, 'after-revoke');
        await origin.signal(channel, 'chat:room-changed', { channel });
        await vi.waitFor(() => {
          expect(otherMessages).toEqual(['after-revoke']);
          expect(otherSignals).toEqual([{ name: 'chat:room-changed', payload: { channel } }]);
        });
        expect(revokedMessages).toEqual([]);
        expect(revokedSignals).toEqual([revocation]);
      });
    }

    if (harness.addPresence) {
      it('getOnlineUserIds excludes anonymous:* connections', async () => {
        const transport = harness.create();
        await harness.addPresence?.(transport, 'room', [
          { userId: 'player-1', connectionId: 'tab-1' },
          { userId: 'anonymous:conn-1', connectionId: 'tab-2' },
        ]);
        const ids = await transport.getOnlineUserIds('room');
        expect(ids).toEqual(['player-1']);
      });

      it('getOnlineUserIds deduplicates concurrent connections for the same user', async () => {
        const transport = harness.create();
        await harness.addPresence?.(transport, 'room', [
          { userId: 'player-1', connectionId: 'tab-1' },
          { userId: 'player-1', connectionId: 'tab-2' },
        ]);
        const ids = await transport.getOnlineUserIds('room');
        expect(ids).toEqual(['player-1']);
      });
    }

    if (harness.simulateFailure) {
      it('getOnlineUserIds degrades to an empty array instead of throwing when unhealthy', async () => {
        const transport = harness.create();
        harness.simulateFailure?.(transport);
        await expect(transport.getOnlineUserIds('room')).resolves.toEqual([]);
      });
    }
  });
}

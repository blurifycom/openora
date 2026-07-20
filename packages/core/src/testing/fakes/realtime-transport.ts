import type { RealtimeTransport, RealtimePresence } from '@openora/core/contracts';

type Handler = (event: unknown) => void;

class InProcessPresence implements RealtimePresence {
  private readonly members = new Map<string, Map<string, Set<string>>>();

  join(channel: string, memberId: string, connectionId: string): void {
    const channelMembers = this.members.get(channel) ?? new Map<string, Set<string>>();
    const connections = channelMembers.get(memberId) ?? new Set<string>();
    connections.add(connectionId);
    channelMembers.set(memberId, connections);
    this.members.set(channel, channelMembers);
  }

  leave(channel: string, memberId: string, connectionId: string): void {
    const channelMembers = this.members.get(channel);
    const connections = channelMembers?.get(memberId);
    if (!channelMembers || !connections) {
      return;
    }
    connections.delete(connectionId);
    if (connections.size === 0) {
      channelMembers.delete(memberId);
    }
    if (channelMembers.size === 0) {
      this.members.delete(channel);
    }
  }

  count(channel: string): number {
    return this.members.get(channel)?.size ?? 0;
  }
}

// Test-only `REALTIME_TRANSPORT` double. Production leaves this seam lazy - it
// throws on first use until an overlay binds a managed vendor (Ably/GetStream).
// See ADR-0007.
export class InProcessRealtimeTransport implements RealtimeTransport {
  private readonly channels = new Map<string, Set<Handler>>();
  readonly presence: RealtimePresence = new InProcessPresence();

  publish<T>(channel: string, event: T): void {
    const subscribers = this.channels.get(channel);
    if (!subscribers) {
      return;
    }
    // Snapshot so a handler that unsubscribes mid-iteration can't corrupt the loop.
    for (const handler of Array.from(subscribers)) {
      try {
        handler(event);
      } catch {
        // failing subscriber must not break fan-out to others
      }
    }
  }

  subscribe<T>(channel: string, handler: (event: T) => void): () => void {
    const set = this.channels.get(channel) ?? new Set<Handler>();
    set.add(handler as Handler);
    this.channels.set(channel, set);
    return () => {
      const current = this.channels.get(channel);
      if (!current) {
        return;
      }
      current.delete(handler as Handler);
      if (current.size === 0) {
        this.channels.delete(channel);
      }
    };
  }
}

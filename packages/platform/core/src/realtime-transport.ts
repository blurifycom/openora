import type { RealtimeTransport, RealtimePresence } from '@oss/adapters';

// Zero-dependency in-process RealtimeTransport. This is the DEFAULT binding:
// publish fans out synchronously to every subscriber in this process, which is
// exactly what the oRPC event-iterator SSE handlers consume. A downstream
// operator binds a managed transport (Ably / GetStream) to REALTIME_TRANSPORT
// for cross-process fan-out and edge connections - module code is unchanged.
// Generalizes the per-connection listener pattern previously inlined in the
// sportsbook service. See ADR-0007.

type Handler = (event: unknown) => void;

class InProcessPresence implements RealtimePresence {
  private readonly members = new Map<string, Set<string>>();

  join(channel: string, memberId: string): void {
    const set = this.members.get(channel) ?? new Set<string>();
    set.add(memberId);
    this.members.set(channel, set);
  }

  leave(channel: string, memberId: string): void {
    const set = this.members.get(channel);
    if (!set) return;
    set.delete(memberId);
    if (set.size === 0) this.members.delete(channel);
  }

  count(channel: string): number {
    return this.members.get(channel)?.size ?? 0;
  }
}

export class InProcessRealtimeTransport implements RealtimeTransport {
  private readonly channels = new Map<string, Set<Handler>>();
  readonly presence: RealtimePresence = new InProcessPresence();

  publish<T>(channel: string, event: T): void {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return;
    // Snapshot so a handler that unsubscribes mid-iteration can't corrupt the loop.
    for (const handler of [...subscribers]) {
      try {
        handler(event);
      } catch {
        // A failing subscriber must not break fan-out to the others.
      }
    }
  }

  subscribe<T>(channel: string, handler: (event: T) => void): () => void {
    const set = this.channels.get(channel) ?? new Set<Handler>();
    set.add(handler as Handler);
    this.channels.set(channel, set);
    return () => {
      const current = this.channels.get(channel);
      if (!current) return;
      current.delete(handler as Handler);
      if (current.size === 0) this.channels.delete(channel);
    };
  }
}

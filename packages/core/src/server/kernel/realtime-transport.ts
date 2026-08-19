import type { RealtimePresence, RealtimeTransport } from '@openora/core/contracts';

type Handler = (event: unknown) => void;
type Subscription = { handler: Handler; clientId?: string };

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

  /** Returns authenticated member IDs (excludes anonymous:* entries). */
  getUserIds(channel: string): string[] {
    const channelMembers = this.members.get(channel);
    if (!channelMembers) {
      return [];
    }
    return Array.from(channelMembers.keys()).filter((id) => !id.startsWith('anonymous:'));
  }
}

/** First-party process-local fan-out used by the default SSE transport. */
export class InProcessRealtimeTransport implements RealtimeTransport {
  private readonly channels = new Map<string, Set<Subscription>>();
  private readonly inProcessPresence = new InProcessPresence();
  readonly presence: RealtimePresence = this.inProcessPresence;

  publish<T>(channel: string, event: T): void {
    const subscribers = this.channels.get(channel);
    if (!subscribers) {
      return;
    }
    // Snapshot so a handler that unsubscribes mid-iteration can't corrupt the loop.
    for (const { handler } of Array.from(subscribers)) {
      try {
        handler(event);
      } catch {
        // One disconnected subscriber must not stop fan-out to others.
      }
    }
  }

  remove<T>(channel: string, event: T): void {
    this.publish(channel, event);
  }

  subscribe<T>(channel: string, handler: (event: T) => void, clientId?: string): () => void {
    const subscribers = this.channels.get(channel) ?? new Set<Subscription>();
    const subscription = { handler: handler as Handler, clientId };
    subscribers.add(subscription);
    this.channels.set(channel, subscribers);
    return () => {
      const current = this.channels.get(channel);
      if (!current) {
        return;
      }
      current.delete(subscription);
      if (current.size === 0) {
        this.channels.delete(channel);
      }
    };
  }

  revokeClientFromChannel(clientId: string, channel: string): void {
    const subscribers = this.channels.get(channel);
    if (!subscribers) {
      return;
    }
    for (const subscription of Array.from(subscribers)) {
      if (subscription.clientId === clientId) {
        subscribers.delete(subscription);
      }
    }
    if (subscribers.size === 0) {
      this.channels.delete(channel);
    }
  }

  getOnlineUserIds(channel: string): Promise<string[]> {
    return Promise.resolve(this.inProcessPresence.getUserIds(channel));
  }
}

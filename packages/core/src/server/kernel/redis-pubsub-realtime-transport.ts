import type { RealtimePresence, RealtimeTransport } from '@openora/core/contracts';
import type { RedisClient } from './redis-client.js';
import { createLogger } from './logger.js';

const CHANNEL_PREFIX = 'oss:rt:';

type Handler = (event: unknown) => void;
type Subscription = { handler: Handler; clientId?: string };

type ChannelState = {
  handlers: Set<Subscription>;
  listener: (message: string) => void;
};

/**
 * Process-local presence, identical in shape to the deleted `InProcessRealtimeTransport`'s.
 * Not shared across replicas - a Redis SET + heartbeat/TTL is the upgrade path ADR-0031
 * calls out for a feature that needs a cluster-wide count - but a replica-local count is
 * still correct for the common single-instance deployment and degrades to an undercount
 * (never a crash or a wrong-direction over-count) on a multi-instance one, so
 * `chat.getOnlineCount` and friends keep working rather than silently reporting zero.
 */
class LocalPresence implements RealtimePresence {
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

  userIds(channel: string): string[] {
    const channelMembers = this.members.get(channel);
    if (!channelMembers) {
      return [];
    }
    return Array.from(channelMembers.keys()).filter((id) => !id.startsWith('anonymous:'));
  }
}

/**
 * Reference `REALTIME_TRANSPORT` driver on Redis Pub/Sub, auto-bound by `createApp`
 * when `REDIS_URL` is set - the only `REALTIME_TRANSPORT` core ships (ADR-0031
 * supersedes ADR-0032's note that the in-process fakes stay as the production
 * default; there is no in-process fallback, matching every other durable seam).
 * Pub/Sub, not Streams: this is client-facing UI push, not a durable inter-service
 * event - the outbox and `MESSAGE_BROKER`'s at-least-once/ack machinery deliberately
 * do not apply here (see `messaging-and-microservices`). A message published while
 * nobody is subscribed, or while a Redis blip drops the subscriber connection, is
 * simply lost - that is why the wallet/chat channels carry a change *signal*, never
 * the balance/message itself: the client treats every (re)connect as "maybe missed
 * something" and refetches over HTTP, so a lost frame is invisible rather than a
 * stale number on screen (see `docs/modules/wallet.md`).
 *
 * Channel names are prefixed with `serviceName` (the same durable per-deployment
 * identity `RedisStreamsBroker` uses for its consumer group), so two deployments
 * sharing one Redis - each with its own `SERVICE_NAME` - never cross-deliver. As with
 * the streams broker, deployments that both leave `SERVICE_NAME` unset both fall back
 * to `monolith` and DO share a namespace; that tradeoff is accepted platform-wide, not
 * reintroduced here.
 *
 * Mirrors `RedisStreamsBroker`'s connection split: `publish` runs on the shared
 * command client (non-blocking `PUBLISH`), while `subscribe` runs on a
 * `client.duplicate()`d connection, because a client in Redis subscriber mode cannot
 * issue any other command. node-redis re-issues every tracked `SUBSCRIBE` after its
 * `reconnectStrategy` re-opens the socket, so a reconnect resumes fan-out with no
 * action needed here; each channel coalesces every local `subscribe()` call into ONE
 * Redis subscription, fanning out to every local handler (one Redis round trip per
 * channel regardless of how many local handlers share it, same fan-out shape the
 * deleted in-process transport had per-process).
 *
 * `presence`/`getOnlineUserIds` are backed by `LocalPresence` - see its docstring for
 * why that is a deliberate, disclosed limitation rather than a full port.
 */
export class RedisPubSubRealtimeTransport implements RealtimeTransport {
  private readonly logger = createLogger('realtime-transport');
  private readonly subscriber: RedisClient;
  private readonly subscriberReady: Promise<void>;
  private readonly channels = new Map<string, ChannelState>();
  private readonly localPresence = new LocalPresence();
  readonly presence: RealtimePresence = this.localPresence;

  constructor(
    private readonly client: RedisClient,
    private readonly serviceName: string,
  ) {
    this.subscriber = client.duplicate();
    this.subscriber.on('error', (err: unknown) =>
      this.logger.error({ err }, 'realtime subscriber connection error'),
    );
    this.subscriberReady = this.subscriber
      .connect()
      .then(() => undefined)
      .catch((err: unknown) => {
        this.logger.error({ err }, 'realtime subscriber connect failed');
        throw err;
      });
  }

  private channelKey(channel: string): string {
    return `${CHANNEL_PREFIX}${this.serviceName}:${channel}`;
  }

  async publish<T>(channel: string, event: T): Promise<void> {
    if (!this.client.isReady) {
      this.logger.error({ channel }, 'realtime publish dropped: redis not ready');
      return;
    }
    try {
      await this.client.publish(this.channelKey(channel), JSON.stringify(event));
    } catch (err) {
      this.logger.error({ err, channel }, 'realtime publish failed');
    }
  }

  remove<T>(channel: string, event: T): Promise<void> {
    return this.publish(channel, event);
  }

  subscribe<T>(channel: string, handler: (event: T) => void, clientId?: string): () => void {
    const key = this.channelKey(channel);
    const subscription: Subscription = { handler: handler as Handler, clientId };

    let state = this.channels.get(key);
    if (!state) {
      const handlers = new Set<Subscription>();
      const listener = (message: string): void => this.dispatch(channel, message, handlers);
      state = { handlers, listener };
      this.channels.set(key, state);
      this.subscriberReady
        .then(() => this.subscriber.subscribe(key, listener))
        .catch((err: unknown) => this.logger.error({ err, channel }, 'realtime subscribe failed'));
    }
    state.handlers.add(subscription);

    return () => {
      const current = this.channels.get(key);
      if (!current || !current.handlers.delete(subscription)) {
        return;
      }
      if (current.handlers.size === 0) {
        this.channels.delete(key);
        this.subscriberReady
          .then(() => this.subscriber.unsubscribe(key, current.listener))
          .catch((err: unknown) =>
            this.logger.error({ err, channel }, 'realtime unsubscribe failed'),
          );
      }
    };
  }

  revokeClientFromChannel(clientId: string, channel: string): void {
    const key = this.channelKey(channel);
    const state = this.channels.get(key);
    if (!state) {
      return;
    }
    for (const subscription of Array.from(state.handlers)) {
      if (subscription.clientId === clientId) {
        state.handlers.delete(subscription);
      }
    }
    if (state.handlers.size === 0) {
      this.channels.delete(key);
      this.subscriberReady
        .then(() => this.subscriber.unsubscribe(key, state.listener))
        .catch((err: unknown) =>
          this.logger.error({ err, channel }, 'realtime unsubscribe failed'),
        );
    }
  }

  /**
   * Backed by the same replica-local `presence` store - see `LocalPresence`. Keyed by
   * the caller's raw channel name, same as `presence.join/leave` (presence is never
   * sent over Redis, so it needs none of `channelKey`'s cross-deployment prefixing).
   */
  getOnlineUserIds(channel: string): Promise<string[]> {
    return Promise.resolve(this.localPresence.userIds(channel));
  }

  async close(): Promise<void> {
    this.channels.clear();
    // Wait for the connect attempt to settle (success or failure) before quitting -
    // node-redis's socket teardown races a `quit()` issued while `connect()` is
    // still in flight (an unhandled `TypeError` inside its own reconnect logic), so
    // a transport closed immediately after construction (eg an unused test double)
    // must not call `quit()` on a socket still mid-handshake.
    const connected = await this.subscriberReady.then(
      () => true,
      () => false,
    );
    if (!connected) {
      return;
    }
    await this.subscriber
      .quit()
      .catch((err: unknown) => this.logger.error({ err }, 'realtime subscriber quit failed'));
  }

  private dispatch(channel: string, message: string, handlers: Set<Subscription>): void {
    let event: unknown;
    try {
      event = JSON.parse(message);
    } catch (err) {
      this.logger.error({ err, channel }, 'realtime event parse failed');
      return;
    }
    for (const { handler } of Array.from(handlers)) {
      try {
        handler(event);
      } catch (err) {
        this.logger.error({ err, channel }, 'realtime handler threw');
      }
    }
  }
}

import type { RealtimePresence, RealtimeTransport } from '@openora/core/contracts';
import type { RedisClient } from './redis-client.js';
import { createLogger } from './logger.js';

const CHANNEL_PREFIX = 'oss:rt:';
const PRESENCE_PREFIX = 'oss:rt:presence:';

type Handler = (event: unknown) => void;
type Subscription = { handler: Handler; clientId?: string };

type ChannelState = {
  handlers: Set<Subscription>;
  listener: (message: string) => void;
};

// Renewed by a per-connection heartbeat for as long as `join()`'s caller keeps the
// connection open (see RedisPresenceStore below); a member with NO live connection
// stops being renewed and ages out of the read-side cutoff after PRESENCE_TTL_MS.
// 3x the heartbeat tolerates up to two consecutive missed ticks (an event-loop
// stall, a slow Redis round trip) without flapping a still-connected member
// offline, while still self-healing a crashed replica's phantom members - the
// failure `/rain` cannot afford - well within one round of rain payouts.
const HEARTBEAT_INTERVAL_MS = 15_000;
const PRESENCE_TTL_MS = HEARTBEAT_INTERVAL_MS * 3;

function presenceZsetKey(serviceName: string, channel: string): string {
  return `${PRESENCE_PREFIX}${serviceName}:${channel}`;
}

function presenceConnsKey(serviceName: string, channel: string, memberId: string): string {
  return `${PRESENCE_PREFIX}${serviceName}:${channel}:${memberId}:conns`;
}

// Atomic per-connection heartbeat, shared by join() (the first beat) and the
// interval it starts: SADD records this connection against its member, PEXPIRE
// renews the member's own bookkeeping set, ZADD (re)scores the member itself with
// "now" in the channel's zset, and ZREMRANGEBYSCORE opportunistically trims
// entries that fell stale before this tick - so members a crashed replica can
// never renew again get swept out gradually by whichever connections keep
// beating in the same channel, instead of the zset growing forever. One
// round trip, run off the shared command client (never the blocking subscriber).
const HEARTBEAT_SCRIPT = `
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3] - ARGV[4])
return 1
`;

// Ref-counted leave: only drop the member from the channel's zset once its LAST
// tracked connection is gone, so one tab closing never marks a member with a
// second tab still open as offline. Returns the connections remaining for the
// member purely for observability - the caller doesn't act on it.
const LEAVE_SCRIPT = `
redis.call('SREM', KEYS[1], ARGV[1])
local remaining = redis.call('SCARD', KEYS[1])
if remaining == 0 then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[2])
end
return remaining
`;

/**
 * Redis-backed `RealtimePresence`: shared across every replica, unlike the
 * deleted process-local `LocalPresence` this supersedes (ADR-0031's disclosed
 * interim - one replica's connections were invisible to `getOnlineUserIds` on
 * another, undercounting `/rain` recipients across instances).
 *
 * One sorted set per channel (`{prefix}:{serviceName}:{channel}`), member =
 * memberId, score = the epoch-ms of that member's most recent heartbeat from ANY
 * of its connections. A member appears in the set AT MOST once regardless of how
 * many tabs it has open - `getOnlineUserIds`/`count` need no application-level
 * dedup, the zset already carries per-member, not per-connection, semantics.
 * A small side SET per (channel, member) tracks which connectionIds are keeping
 * it alive, so `leave()` can ref-count: dropping one tab's connection while
 * another is still open must not remove the member from the channel zset.
 *
 * Membership is self-expiring, not explicitly swept: `join()` fires the first
 * heartbeat and starts an interval that re-fires it every HEARTBEAT_INTERVAL_MS
 * for as long as the connection lives; the read path
 * (`getOnlineUserIds`/`count`) filters the zset to scores newer than
 * PRESENCE_TTL_MS instead of trusting every entry in it. A replica that dies
 * without calling `leave()` (a SIGKILL, an OOM) simply stops renewing its
 * members' scores - they age past the cutoff and silently stop being read as
 * online, with no cleanup process required to run first. That is the property
 * `/rain` needs: a naive Redis SET with explicit add/remove would instead leave
 * a crashed replica's members in the set FOREVER, diluting every rain payout
 * across phantom recipients for good. `leave()` and `close()` still do the
 * explicit removal on the graceful path (immediate, not a 45s wait) - expiry is
 * the safety net, not the primary path.
 *
 * Read cost: `getOnlineUserIds` is one `ZRANGEBYSCORE` on a single key - O(log N)
 * to find the score cutoff plus O(M) to return the M members newer than it, M
 * being exactly the size of the answer. No per-connection scan (a member with
 * ten open tabs is one zset entry, not ten) and no keyspace SCAN (every
 * channel's members live under one key). `count` is `ZCOUNT` on the same key -
 * same cutoff, no materialized list. Both fail safe to `[]`/`0` rather than
 * throwing when Redis is unreachable, matching every other Redis adapter here.
 */
class RedisPresenceStore implements RealtimePresence {
  private readonly logger = createLogger('realtime-presence');
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly client: RedisClient,
    private readonly serviceName: string,
  ) {}

  join(channel: string, memberId: string, connectionId: string): void {
    const key = this.heartbeatKey(channel, memberId, connectionId);
    if (this.heartbeats.has(key)) {
      return;
    }
    this.beat(channel, memberId, connectionId);
    const timer = setInterval(
      () => this.beat(channel, memberId, connectionId),
      HEARTBEAT_INTERVAL_MS,
    );
    timer.unref();
    this.heartbeats.set(key, timer);
  }

  leave(channel: string, memberId: string, connectionId: string): void {
    const key = this.heartbeatKey(channel, memberId, connectionId);
    const timer = this.heartbeats.get(key);
    if (timer) {
      clearInterval(timer);
      this.heartbeats.delete(key);
    }
    if (!this.client.isReady) {
      return;
    }
    this.client
      .eval(LEAVE_SCRIPT, {
        keys: [
          presenceConnsKey(this.serviceName, channel, memberId),
          presenceZsetKey(this.serviceName, channel),
        ],
        arguments: [connectionId, memberId],
      })
      .catch((err: unknown) => this.logger.error({ err, channel }, 'presence leave failed'));
  }

  async count(channel: string): Promise<number> {
    if (!this.client.isReady) {
      return 0;
    }
    try {
      return await this.client.zCount(
        presenceZsetKey(this.serviceName, channel),
        this.cutoff(),
        '+inf',
      );
    } catch (err) {
      this.logger.error({ err, channel }, 'presence count failed');
      return 0;
    }
  }

  async userIds(channel: string): Promise<string[]> {
    if (!this.client.isReady) {
      return [];
    }
    try {
      const members = await this.client.zRangeByScore(
        presenceZsetKey(this.serviceName, channel),
        this.cutoff(),
        '+inf',
      );
      return members.filter((id) => !id.startsWith('anonymous:'));
    } catch (err) {
      this.logger.error({ err, channel }, 'presence userIds failed');
      return [];
    }
  }

  /**
   * Graceful-shutdown path: stop every local heartbeat interval and remove this
   * replica's connections from Redis immediately, rather than leaving them for
   * the TTL to age out. Best-effort - a shutdown that can't reach Redis still
   * completes, since the TTL safety net covers it either way.
   */
  async close(): Promise<void> {
    const keys = [...this.heartbeats.keys()];
    for (const timer of this.heartbeats.values()) {
      clearInterval(timer);
    }
    this.heartbeats.clear();
    if (!this.client.isReady) {
      return;
    }
    await Promise.allSettled(keys.map((key) => this.evictHeartbeatKey(key)));
  }

  private heartbeatKey(channel: string, memberId: string, connectionId: string): string {
    return `${channel} ${memberId} ${connectionId}`;
  }

  private evictHeartbeatKey(key: string): Promise<unknown> {
    const [channel, memberId, connectionId] = key.split(' ') as [string, string, string];
    return this.client
      .eval(LEAVE_SCRIPT, {
        keys: [
          presenceConnsKey(this.serviceName, channel, memberId),
          presenceZsetKey(this.serviceName, channel),
        ],
        arguments: [connectionId, memberId],
      })
      .catch((err: unknown) => this.logger.error({ err, channel }, 'presence evict failed'));
  }

  private beat(channel: string, memberId: string, connectionId: string): void {
    if (!this.client.isReady) {
      return;
    }
    const now = Date.now();
    this.client
      .eval(HEARTBEAT_SCRIPT, {
        keys: [
          presenceConnsKey(this.serviceName, channel, memberId),
          presenceZsetKey(this.serviceName, channel),
        ],
        arguments: [connectionId, memberId, String(now), String(PRESENCE_TTL_MS)],
      })
      .catch((err: unknown) => this.logger.error({ err, channel }, 'presence heartbeat failed'));
  }

  private cutoff(): number {
    return Date.now() - PRESENCE_TTL_MS;
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
 * `presence`/`getOnlineUserIds` are backed by `RedisPresenceStore` - see its
 * docstring for the shared, self-expiring structure behind them.
 */
export class RedisPubSubRealtimeTransport implements RealtimeTransport {
  private readonly logger = createLogger('realtime-transport');
  private readonly subscriber: RedisClient;
  private readonly subscriberReady: Promise<void>;
  private readonly channels = new Map<string, ChannelState>();
  private readonly presenceStore: RedisPresenceStore;
  readonly presence: RealtimePresence;

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
    this.presenceStore = new RedisPresenceStore(client, serviceName);
    this.presence = this.presenceStore;
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
   * Backed by `RedisPresenceStore`, shared across every replica - see its
   * docstring. Keyed by the caller's raw channel name, same as
   * `presence.join/leave` (presence uses its own `oss:rt:presence:` namespace,
   * so it needs none of `channelKey`'s pub/sub-specific prefixing).
   */
  getOnlineUserIds(channel: string): Promise<string[]> {
    return this.presenceStore.userIds(channel);
  }

  async close(): Promise<void> {
    this.channels.clear();
    await this.presenceStore.close();
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

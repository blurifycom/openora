import { randomUUID } from 'node:crypto';
import type {
  MessageBrokerAdapter,
  EventEnvelope,
  BrokerHandler,
  SubscribeOptions,
} from '@openora/core/contracts';
import type { RedisClient } from './redis-client.js';
import { createLogger } from './logger.js';

const STREAM_PREFIX = 'oss:evt:';
const STREAM_MAXLEN = 10_000;
const READ_COUNT = 10;
const BLOCK_MS = 5_000;
const CLAIM_INTERVAL_MS = 30_000;
const CLAIM_MIN_IDLE_MS = 60_000;
const RETRY_DELAY_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Library boundary: node-redis types XREADGROUP/XAUTOCLAIM replies as a broad
// RESP2/RESP3 conditional union driven by the client's negotiated protocol version,
// which TS can't narrow generically. This client (redis-client.ts) never overrides
// RESP/typeMapping, so at runtime the reply is always this plain shape - declared
// once here and cast at the two call sites below.
type StreamMessage = { id: string; message: Record<string, string> };
type StreamReadReply = Array<{ name: string; messages: StreamMessage[] }> | null;
type StreamClaimReply = {
  nextId: string;
  messages: (StreamMessage | null)[];
  deletedMessages: string[];
};

type RedisStreamsBrokerOptions = {
  serviceName: string;

  // Where a consumer group starts reading, on the ONE pass that creates it (a group
  // that already exists comes back BUSYGROUP and keeps its own cursor, so this never
  // rewinds a running deployment). '$' - the default - takes only events published
  // after creation; '0' replays everything still retained in the stream (up to
  // STREAM_MAXLEN). See the class docstring for which to pick.
  startId?: '$' | '0';
};

type ConsumerLoop = {
  handlers: Set<BrokerHandler>;
  stop: () => void;
  done: Promise<void>;
};

function streamKey(topic: string): string {
  return STREAM_PREFIX + topic;
}

function isBusyGroupError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('BUSYGROUP');
}

/**
 * Durable `MESSAGE_BROKER` reference driver on Redis Streams, auto-bound by
 * `createApp` when `REDIS_URL` is set (ADR-0030 - production is distributed-only,
 * core ships no in-process default).
 *
 * Every `subscribe(topic, handler)` call for the same (topic, group) - default
 * group is the deployment's `serviceName` - coalesces into ONE Redis consumer-group
 * loop that fans out to every registered local handler, then XACKs once: an event
 * is delivered to exactly one replica of the service (competing consumers across
 * replicas via the shared group), and that replica runs every local handler for
 * the topic (matches in-process fan-out semantics, but once per cluster, not once
 * per replica). A distinct `SERVICE_NAME` per split service gives each service its
 * own copy of every event; `createApp` requires one as soon as `SERVICE_MANIFEST`
 * is set, since the group name is a durable identity and can't be derived from a
 * module list that reorders and grows.
 *
 * Blocking `XREADGROUP` runs on a `client.duplicate()`d connection per loop, never
 * on the shared client - `publish` (`XADD`, non-blocking) uses the shared client,
 * so a blocked read never stalls the cache/rate-limiter commands sharing it.
 * `publish` awaits the XADD and lets errors propagate (the `OutboxRelay` marks a
 * row published only after this resolves - it must be reliable, not a silent
 * no-op). Handler errors are guarded + logged, then the entry is XACKed regardless
 * (matches `EventBus.on` - no per-handler retry; must-not-lose events use the
 * outbox). A crash before XACK leaves the entry pending; `XAUTOCLAIM` periodically
 * reclaims idle-pending entries so at-least-once delivery survives a replica crash.
 *
 * At-least-once holds from group creation onward, NOT before it. A group is created
 * at `startId` (default `$`) on first subscribe and persists in Redis from then on,
 * so restarts and outages are covered: the group keeps its cursor, undelivered
 * entries wait in the stream, and pending ones are reclaimed. The one uncovered
 * window is a group's FIRST-EVER creation - a service extracted after events were
 * already flowing starts from `$` and never sees the backlog. `startId: '0'` closes
 * that window by replaying everything still retained (up to STREAM_MAXLEN), at the
 * cost of re-running every handler for those events: safe on a fresh deploy (empty
 * streams), a duplicate-side-effect hazard for a late-added service, since core has
 * no dedup layer - `EventBus.on` invokes handlers directly, and `eventId` is a key
 * consumers must dedup on themselves.
 *
 * `orderingKey` is NOT honoured - Redis Streams have no partitioning, so per-key
 * ordering across concurrent consumers isn't guaranteed (same footnote as
 * `BullMqJobQueue`'s `orderingKey`).
 */
export class RedisStreamsBroker implements MessageBrokerAdapter {
  private readonly logger = createLogger('message-broker');
  private readonly serviceName: string;
  private readonly startId: '$' | '0';
  private readonly consumerId = randomUUID();
  private readonly loops = new Map<string, ConsumerLoop>();

  constructor(
    private readonly client: RedisClient,
    opts: RedisStreamsBrokerOptions,
  ) {
    this.serviceName = opts.serviceName;
    this.startId = opts.startId ?? '$';
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    await this.client.xAdd(
      streamKey(envelope.topic),
      '*',
      { data: JSON.stringify(envelope) },
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: STREAM_MAXLEN } },
    );
  }

  subscribe(topic: string, handler: BrokerHandler, options?: SubscribeOptions): () => void {
    const group = options?.consumerGroup ?? this.serviceName;
    const key = streamKey(topic);
    const loopKey = `${key}::${group}`;

    let loop = this.loops.get(loopKey);
    if (!loop) {
      loop = this.startLoop(key, group);
      this.loops.set(loopKey, loop);
    }
    loop.handlers.add(handler);

    return () => {
      const current = this.loops.get(loopKey);
      if (!current || !current.handlers.delete(handler)) {
        return;
      }
      if (current.handlers.size === 0) {
        this.loops.delete(loopKey);
        current.stop();
      }
    };
  }

  async close(): Promise<void> {
    const loops = [...this.loops.values()];
    this.loops.clear();
    for (const loop of loops) {
      loop.stop();
    }
    await Promise.allSettled(loops.map((loop) => loop.done));
  }

  private startLoop(key: string, group: string): ConsumerLoop {
    const handlers = new Set<BrokerHandler>();
    const reader = this.client.duplicate();
    reader.on('error', (err: unknown) =>
      this.logger.error({ err, key, group }, 'stream reader connection error'),
    );

    let stopped = false;
    let lastClaimAt = 0;

    const stop = (): void => {
      stopped = true;
      // Rejects the in-flight blocking XREADGROUP (if any) immediately, instead of
      // waiting up to BLOCK_MS for it to time out on its own.
      reader.destroy();
    };

    // `ready` gates connecting + group creation, and stays false until BOTH have
    // succeeded - so a Redis outage at loop start retries the whole handshake with
    // backoff rather than permanently abandoning this (topic, group)'s consumption.
    // It is NOT reset on a later error: node-redis owns reconnection from there on
    // (socket.reconnectStrategy re-establishes the connection and re-queues the
    // blocked XREADGROUP), and the group already exists, so there is nothing to redo.
    // Both steps are idempotent regardless - `connect()` throws 'Socket already
    // opened' once the socket is open, hence the isOpen guard, and a re-created group
    // comes back BUSYGROUP, which is tolerated below.
    const done = (async (): Promise<void> => {
      let ready = false;
      while (!stopped) {
        try {
          if (!ready) {
            if (!reader.isOpen) {
              await reader.connect();
            }
            try {
              await reader.xGroupCreate(key, group, this.startId, { MKSTREAM: true });
            } catch (err) {
              if (!isBusyGroupError(err)) {
                throw err;
              }
            }
            ready = true;
          }
          if (Date.now() - lastClaimAt > CLAIM_INTERVAL_MS) {
            lastClaimAt = Date.now();
            await this.reclaimPending(reader, key, group, handlers);
          }
          const reply = (await reader.xReadGroup(
            group,
            this.consumerId,
            { key, id: '>' },
            { COUNT: READ_COUNT, BLOCK: BLOCK_MS },
          )) as StreamReadReply;
          if (!reply) {
            continue;
          }
          for (const stream of reply) {
            for (const message of stream.messages) {
              await this.dispatch(reader, key, group, message, handlers);
            }
          }
        } catch (err) {
          if (stopped) {
            break;
          }
          this.logger.error({ err, key, group }, 'stream loop error, retrying');
          await delay(RETRY_DELAY_MS);
        }
      }
    })();

    return { handlers, stop, done };
  }

  private async reclaimPending(
    reader: RedisClient,
    key: string,
    group: string,
    handlers: Set<BrokerHandler>,
  ): Promise<void> {
    try {
      const claimed = (await reader.xAutoClaim(
        key,
        group,
        this.consumerId,
        CLAIM_MIN_IDLE_MS,
        '0-0',
        { COUNT: READ_COUNT },
      )) as StreamClaimReply;
      for (const message of claimed.messages) {
        if (message) {
          await this.dispatch(reader, key, group, message, handlers);
        }
      }
    } catch (err) {
      this.logger.error({ err, key, group }, 'stream reclaim failed');
    }
  }

  private async dispatch(
    reader: RedisClient,
    key: string,
    group: string,
    message: StreamMessage,
    handlers: Set<BrokerHandler>,
  ): Promise<void> {
    const raw = message.message['data'];
    if (raw === undefined) {
      await reader.xAck(key, group, message.id);
      return;
    }
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(raw);
    } catch (err) {
      this.logger.error({ err, key, group, id: message.id }, 'stream envelope parse failed');
      await reader.xAck(key, group, message.id);
      return;
    }
    for (const fn of handlers) {
      try {
        await fn(envelope);
      } catch (err) {
        this.logger.error({ err, topic: envelope.topic }, 'message broker handler threw');
      }
    }
    await reader.xAck(key, group, message.id);
  }
}

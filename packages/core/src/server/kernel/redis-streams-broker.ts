import { randomUUID } from 'node:crypto';
import type {
  MessageBrokerAdapter,
  EventEnvelope,
  BrokerHandler,
  SubscribeOptions,
} from '@openora/core/contracts';
import type { RedisClient } from './redis-client.js';
import { createLogger } from './logger.js';
import { EVENT_RETENTION_MS } from './event-bus.js';

const STREAM_PREFIX = 'oss:evt:';
const DLQ_PREFIX = 'oss:dlq:';
const READ_COUNT = 10;
const BLOCK_MS = 5_000;
const CLAIM_INTERVAL_MS = 30_000;
const CLAIM_MIN_IDLE_MS = 60_000;
const RETRY_DELAY_MS = 2_000;
// Deliveries (first read + reclaims) after which a still-failing entry is dead-lettered.
export const MAX_DELIVERIES = 5;

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
  // EVENT_RETENTION_MS). See the class docstring for which to pick.
  startId?: '$' | '0';

  // How often idle-pending entries are reclaimed for retry, and how long an entry must
  // sit unacknowledged first. Tests shorten these; production keeps the defaults.
  reclaim?: { intervalMs: number; minIdleMs: number };
};

type ConsumerLoop = {
  handlers: Set<BrokerHandler>;
  stop: () => void;
  done: Promise<void>;
};

function streamKey(topic: string): string {
  return STREAM_PREFIX + topic;
}

function dlqKey(streamKeyName: string): string {
  return DLQ_PREFIX + streamKeyName.slice(STREAM_PREFIX.length);
}

// A stream id is `<ms since epoch>-<seq>`, stamped by Redis on XADD.
function streamIdTime(id: string): number {
  return Number(id.split('-')[0]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * no-op). Every local handler runs even when a sibling throws; the entry is XACKed
 * only when all of them succeeded. A failure (or a crash before XACK) leaves it
 * pending, and `XAUTOCLAIM` reclaims idle-pending entries every `CLAIM_INTERVAL_MS`
 * and redelivers them - to every local handler again, so `EventBus.on` skips the
 * ones that already succeeded via `processed_events`. An entry still failing on its
 * `MAX_DELIVERIES`th delivery (or one that is not valid JSON) is copied to the
 * `oss:dlq:<topic>` stream with its group, stream id, delivery count and last
 * error, then XACKed. The DLQ is never trimmed; an operator drains it.
 *
 * ponytail: retention is time-based (`MINID ~ now - EVENT_RETENTION_MS` on every
 * XADD), so a group that falls more than 7 days behind loses the entries it never
 * read, and stream memory is bounded by traffic x 7 days, not by a count. Alert on
 * consumer-group lag; move to a broker overlay with disk-backed retention if either
 * ceiling bites.
 *
 * At-least-once holds from group creation onward, NOT before it. A group is created
 * at `startId` (default `$`) on first subscribe and persists in Redis from then on,
 * so restarts and outages are covered: the group keeps its cursor, undelivered
 * entries wait in the stream, and pending ones are reclaimed. The one uncovered
 * window is a group's FIRST-EVER creation - a service extracted after events were
 * already flowing starts from `$` and never sees the backlog. `startId: '0'` closes
 * that window by replaying everything still retained (up to EVENT_RETENTION_MS), at
 * the cost of running every handler of the new service for that backlog.
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
  private readonly claimIntervalMs: number;
  private readonly claimMinIdleMs: number;

  constructor(
    private readonly client: RedisClient,
    opts: RedisStreamsBrokerOptions,
  ) {
    this.serviceName = opts.serviceName;
    this.startId = opts.startId ?? '$';
    this.claimIntervalMs = opts.reclaim?.intervalMs ?? CLAIM_INTERVAL_MS;
    this.claimMinIdleMs = opts.reclaim?.minIdleMs ?? CLAIM_MIN_IDLE_MS;
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    await this.client.xAdd(
      streamKey(envelope.topic),
      '*',
      { data: JSON.stringify(envelope) },
      {
        TRIM: {
          strategy: 'MINID',
          strategyModifier: '~',
          threshold: Date.now() - EVENT_RETENTION_MS,
        },
      },
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
    let claimCursor = '0-0';

    const stop = (): void => {
      stopped = true;
      // Rejects the in-flight blocking XREADGROUP (if any) immediately, instead of
      // waiting up to BLOCK_MS for it to time out on its own.
      reader.destroy();
    };

    // `ready` gates connecting + group creation, and stays false until BOTH have
    // succeeded - so a Redis outage at loop start retries the whole handshake with
    // backoff rather than permanently abandoning this (topic, group)'s consumption.
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
          if (Date.now() - lastClaimAt > this.claimIntervalMs) {
            lastClaimAt = Date.now();
            claimCursor = await this.reclaimPending(reader, key, group, handlers, claimCursor);
          }
          const reply = (await reader.xReadGroup(
            group,
            this.consumerId,
            { key, id: '>' },
            { COUNT: READ_COUNT, BLOCK: Math.min(BLOCK_MS, this.claimIntervalMs) },
          )) as StreamReadReply;
          if (!reply) {
            continue;
          }
          for (const stream of reply) {
            for (const message of stream.messages) {
              await this.dispatch(reader, key, group, message, handlers, 1);
            }
          }
        } catch (err) {
          if (stopped) {
            break;
          }
          ready = false;
          this.logger.error({ err, key, group }, 'stream loop error, retrying');
          await delay(RETRY_DELAY_MS);
        }
      }
    })();

    return { handlers, stop, done };
  }

  // Walks the whole pending list each interval (XAUTOCLAIM pages until cursor 0-0), so a
  // backlog drains at read speed rather than one page per interval. Returns the cursor to
  // resume from if a page fails.
  private async reclaimPending(
    reader: RedisClient,
    key: string,
    group: string,
    handlers: Set<BrokerHandler>,
    cursor: string,
  ): Promise<string> {
    let next = cursor;
    try {
      do {
        const claimed = (await reader.xAutoClaim(
          key,
          group,
          this.consumerId,
          this.claimMinIdleMs,
          next,
          { COUNT: READ_COUNT },
        )) as StreamClaimReply;
        if (claimed.deletedMessages.length > 0) {
          this.logger.error(
            { key, group, ids: claimed.deletedMessages },
            'pending stream entries were trimmed before they were processed',
          );
        }
        for (const message of claimed.messages) {
          if (!message) {
            continue;
          }
          const deliveries = await this.deliveryCount(reader, key, group, message.id);
          // MINID trimming is approximate and pending entries survive it, so one can outlive
          // the processed_events rows that dedupe it. Re-running it would repeat handlers that
          // already succeeded; it goes to the dead-letter stream for a human instead.
          if (streamIdTime(message.id) < Date.now() - EVENT_RETENTION_MS) {
            await this.deadLetter(
              reader,
              key,
              group,
              message,
              deliveries,
              new Error('pending past the event retention window'),
            );
            continue;
          }
          await this.dispatch(reader, key, group, message, handlers, deliveries);
        }
        next = claimed.nextId;
      } while (next !== '0-0');
      return next;
    } catch (err) {
      this.logger.error({ err, key, group }, 'stream reclaim failed');
      return next;
    }
  }

  private async deliveryCount(
    reader: RedisClient,
    key: string,
    group: string,
    id: string,
  ): Promise<number> {
    const [entry] = await reader.xPendingRange(key, group, id, id, 1);
    return entry?.deliveriesCounter ?? 1;
  }

  private async deadLetter(
    reader: RedisClient,
    key: string,
    group: string,
    message: StreamMessage,
    deliveries: number,
    err: unknown,
  ): Promise<void> {
    await reader.xAdd(dlqKey(key), '*', {
      data: message.message['data'] ?? '',
      group,
      streamId: message.id,
      deliveries: String(deliveries),
      error: errorMessage(err),
    });
    await reader.xAck(key, group, message.id);
    this.logger.error({ err, key, group, id: message.id, deliveries }, 'event dead-lettered');
  }

  private async dispatch(
    reader: RedisClient,
    key: string,
    group: string,
    message: StreamMessage,
    handlers: Set<BrokerHandler>,
    deliveries: number,
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
      await this.deadLetter(reader, key, group, message, deliveries, err);
      return;
    }
    let failure: { err: unknown } | undefined;
    for (const fn of handlers) {
      try {
        await fn(envelope);
      } catch (err) {
        failure = { err };
        this.logger.error(
          { err, topic: envelope.topic, deliveries },
          'message broker handler threw',
        );
      }
    }
    if (!failure) {
      await reader.xAck(key, group, message.id);
    } else if (deliveries >= MAX_DELIVERIES) {
      await this.deadLetter(reader, key, group, message, deliveries, failure.err);
    }
  }
}

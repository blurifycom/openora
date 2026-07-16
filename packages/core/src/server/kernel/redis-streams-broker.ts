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
 * per replica). A distinct `SERVICE_NAME` per split service (`SERVICE_MANIFEST`)
 * gives each service its own copy of every event.
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
 * `orderingKey` is NOT honoured - Redis Streams have no partitioning, so per-key
 * ordering across concurrent consumers isn't guaranteed (same footnote as
 * `BullMqJobQueue`'s `orderingKey`).
 */
export class RedisStreamsBroker implements MessageBrokerAdapter {
  private readonly logger = createLogger('message-broker');
  private readonly serviceName: string;
  private readonly consumerId = randomUUID();
  private readonly loops = new Map<string, ConsumerLoop>();

  constructor(
    private readonly client: RedisClient,
    opts: RedisStreamsBrokerOptions,
  ) {
    this.serviceName = opts.serviceName;
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

    // `ready` gates (re-)connecting + group creation: false on the very first pass
    // and again after any error, so a Redis outage at loop start (or a drop the
    // client's own reconnectStrategy doesn't paper over) is retried with backoff
    // rather than permanently abandoning this (topic, group)'s consumption.
    const done = (async (): Promise<void> => {
      let ready = false;
      while (!stopped) {
        try {
          if (!ready) {
            await reader.connect();
            try {
              await reader.xGroupCreate(key, group, '$', { MKSTREAM: true });
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

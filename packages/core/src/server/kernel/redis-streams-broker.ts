import { randomUUID } from 'node:crypto';
import type {
  MessageBrokerAdapter,
  EventEnvelope,
  BrokerHandler,
  DeadLetters,
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
const PENDING_LAG_THRESHOLD = 100;
const LAG_LOG_INTERVAL_MS = 60_000;
const MAX_DELIVERIES = 5;

export function streamStartIdFromEnv(raw: string | undefined, splitService: boolean): '$' | '0' {
  if (raw === undefined || raw === '' || raw === '$') {
    return '$';
  }
  if (raw === '0' && !splitService) {
    throw new Error(
      'EVENT_BUS_START_ID=0 needs SERVICE_MANIFEST. Only a newly split service starts its consumer ' +
        'groups at the oldest retained event; the main API would replay every handler it runs.',
    );
  }
  if (raw === '0') {
    return '0';
  }
  throw new Error(`EVENT_BUS_START_ID must be "$" or "0", got "${raw}".`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type StreamMessage = { id: string; message: Record<string, string> };
type StreamReadReply = Array<{ name: string; messages: StreamMessage[] }> | null;
type StreamClaimReply = {
  nextId: string;
  messages: (StreamMessage | null)[];
  deletedMessages: string[];
};

type RedisStreamsBrokerOptions = {
  serviceName: string;

  startId?: '$' | '0';

  reclaim?: { intervalMs: number; minIdleMs: number };
};

type ConsumerLoop = {
  handlers: Set<BrokerHandler>;
  stop: () => void;
  done: Promise<void>;
};

export function streamKey(topic: string): string {
  return STREAM_PREFIX + topic;
}

export function dlqKey(streamKeyName: string): string {
  return DLQ_PREFIX + streamKeyName.slice(STREAM_PREFIX.length);
}

export function streamIdTime(id: string): number {
  return Number(id.split('-')[0]);
}

export function streamIdAfter(a: string, b: string): boolean {
  const [aTime = 0n, aSeq = 0n] = a.split('-').map(BigInt);
  const [bTime = 0n, bSeq = 0n] = b.split('-').map(BigInt);
  return aTime > bTime || (aTime === bTime && aSeq > bSeq);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isBusyGroupError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('BUSYGROUP');
}

export class RedisStreamsBroker implements MessageBrokerAdapter {
  private readonly logger = createLogger('message-broker');
  private readonly serviceName: string;
  private readonly startId: '$' | '0';
  private readonly consumerId = randomUUID();
  private readonly loops = new Map<string, ConsumerLoop>();
  private readonly lagLoggedAt = new Map<string, number>();
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

  async deadLetters(): Promise<DeadLetters> {
    let count = 0;
    let newest: { key: string; id: string } | null = null;
    for await (const keys of this.client.scanIterator({
      MATCH: `${DLQ_PREFIX}*`,
      TYPE: 'stream',
      COUNT: 1000,
    })) {
      for (const key of keys) {
        count += await this.client.xLen(key);
        const [last] = await this.client.xRevRange(key, '+', '-', { COUNT: 1 });
        if (last && (!newest || streamIdAfter(last.id, newest.id))) {
          newest = { key, id: last.id };
        }
      }
    }
    return { count, newest: newest && `${newest.key}/${newest.id}` };
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
      reader.destroy();
    };

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
            await this.reportLag(reader, key, group);
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

  private async reportLag(reader: RedisClient, key: string, group: string): Promise<void> {
    try {
      const { pending } = await reader.xPending(key, group);
      const lagKey = `${key}\0${group}`;
      const due = Date.now() - (this.lagLoggedAt.get(lagKey) ?? 0) >= LAG_LOG_INTERVAL_MS;
      if (pending > PENDING_LAG_THRESHOLD && due) {
        this.lagLoggedAt.set(lagKey, Date.now());
        this.logger.warn({ stream: key, group, pending }, 'stream consumer lagging');
      }
    } catch (err) {
      this.logger.error({ err, stream: key, group }, 'stream lag check failed');
    }
  }

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

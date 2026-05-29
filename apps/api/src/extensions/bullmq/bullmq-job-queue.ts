import { Queue, Worker, type Job, type RedisOptions } from 'bullmq';
import type {
  JobQueueAdapter,
  QueueName,
  EnqueueOptions,
  RepeatOptions,
  JobContext,
  WorkerRegistration,
} from '@oss/adapters';

// Durable JobQueueAdapter backed by BullMQ + Redis - the reference real driver.
// Bound to JOB_QUEUE by the bullmq overlay only when REDIS_URL is set, so the
// in-process default stays in effect for `pnpm dev`, seed, tests and CI. Gives
// persistence, cross-process workers, native delayed/repeatable jobs, retry +
// backoff and dead-letter. Delivery is at-least-once - handlers MUST be
// idempotent (the seam's idempotencyKey maps to BullMQ's jobId, but a DB guard
// is still required for money jobs). See ADR-0014.

// Minimal logger shape so this overlay needn't depend on pino directly; the
// pino Logger passed in by the plugin satisfies it structurally.
interface OverlayLogger {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

// The envelope put on every job: the typed payload plus tracing metadata and the
// ordering key, so a worker can rebuild the JobContext.
interface JobEnvelope {
  payload: unknown;
  meta: Record<string, string | undefined>;
  orderingKey?: string;
}

// Parse a redis[s]:// URL into BullMQ connection options. Passing options (not a
// shared IORedis instance) sidesteps cross-version ioredis type clashes and lets
// BullMQ own connection lifecycle - closed via worker.close()/queue.close().
function parseRedisUrl(redisUrl: string): RedisOptions {
  const u = new URL(redisUrl);
  const opts: RedisOptions = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    // Required by BullMQ for its blocking commands.
    maxRetriesPerRequest: null,
  };
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.pathname && u.pathname.length > 1) opts.db = Number(u.pathname.slice(1)) || 0;
  if (u.protocol === 'rediss:') opts.tls = {};
  return opts;
}

export class BullMqJobQueue implements JobQueueAdapter {
  private readonly connection: RedisOptions;
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  constructor(
    redisUrl: string,
    private readonly logger: OverlayLogger,
  ) {
    this.connection = parseRedisUrl(redisUrl);
  }

  private getQueue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue<T>(
    name: QueueName,
    payload: T,
    opts: EnqueueOptions = {},
  ): Promise<{ id: string }> {
    const envelope: JobEnvelope = {
      payload,
      meta: { ...opts.meta, idempotencyKey: opts.idempotencyKey },
      orderingKey: opts.orderingKey,
    };
    const job = await this.getQueue(name).add(name, envelope, {
      jobId: opts.idempotencyKey, // dedupe: a second add with the same id is a no-op
      delay: opts.delayMs,
      attempts: opts.attempts,
      backoff: opts.backoff
        ? { type: opts.backoff.type, delay: opts.backoff.delayMs }
        : undefined,
      priority: opts.priority,
      removeOnComplete: true,
      removeOnFail: false, // keep failed jobs for inspection / DLQ visibility
    });
    return { id: job.id ?? opts.idempotencyKey ?? '' };
  }

  registerWorker<T>(registration: WorkerRegistration<T>): void {
    const { queue: name, schema, handler, options, onDeadLetter } = registration;

    const worker = new Worker<JobEnvelope>(
      name,
      async (job: Job<JobEnvelope>) => {
        const ctx: JobContext<T> = {
          id: job.id ?? '',
          name,
          payload: schema.parse(job.data.payload),
          attempt: job.attemptsMade + 1,
          enqueuedAt: new Date(job.timestamp),
          meta: job.data.meta ?? {},
        };
        await handler(ctx);
      },
      { connection: this.connection, concurrency: options?.concurrency ?? 1 },
    );

    worker.on('failed', (job, err) => {
      if (!job) return;
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      this.logger.error(
        { queue: name, jobId: job.id, attempt: job.attemptsMade, exhausted, err: err.message },
        '[job-queue:bullmq] job failed',
      );
      if (exhausted && onDeadLetter) {
        const ctx: JobContext<T> = {
          id: job.id ?? '',
          name,
          payload: job.data.payload as T,
          attempt: job.attemptsMade,
          enqueuedAt: new Date(job.timestamp),
          meta: job.data.meta ?? {},
        };
        void Promise.resolve(onDeadLetter(ctx, err)).catch((hookErr) =>
          this.logger.error(
            { queue: name, jobId: job.id, err: String(hookErr) },
            '[job-queue:bullmq] onDeadLetter hook threw',
          ),
        );
      }
    });

    this.workers.push(worker);
  }

  async schedule<T>(
    name: QueueName,
    scheduleId: string,
    payload: T,
    repeat: RepeatOptions,
  ): Promise<void> {
    const envelope: JobEnvelope = { payload, meta: { scheduleId } };
    await this.getQueue(name).upsertJobScheduler(
      scheduleId,
      { pattern: repeat.cron, every: repeat.everyMs, tz: repeat.timezone },
      { name, data: envelope },
    );
  }

  async unschedule(name: QueueName, scheduleId: string): Promise<void> {
    await this.getQueue(name).removeJobScheduler(scheduleId);
  }

  async close(): Promise<void> {
    // Workers first: worker.close() waits for active jobs to finish (drain),
    // then queues. BullMQ owns and closes the underlying connections.
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

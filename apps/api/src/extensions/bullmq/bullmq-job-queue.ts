import { Queue, Worker, type Job, type RedisOptions } from 'bullmq';
import type {
  JobQueueAdapter,
  QueueName,
  EnqueueOptions,
  RepeatOptions,
  JobContext,
  WorkerRegistration,
} from '@oss/core/contracts';

// Durable JobQueueAdapter backed by BullMQ + Redis. Bound to JOB_QUEUE only when
// REDIS_URL is set; the in-process default stays in effect for dev/seed/CI.
// Delivery is at-least-once - a DB guard is still required for money jobs (ADR-0014).

// Minimal logger shape; pino Logger satisfies it structurally.
type OverlayLogger = {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
};

type JobEnvelope = {
  payload: unknown;
  meta: Record<string, string | undefined>;
  orderingKey?: string;
};

// Passing options (not a shared IORedis instance) sidesteps cross-version ioredis
// type clashes and lets BullMQ own the connection lifecycle.
function parseRedisUrl(redisUrl: string): RedisOptions {
  const u = new URL(redisUrl);
  const opts: RedisOptions = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    maxRetriesPerRequest: null, // required by BullMQ for blocking commands
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
      jobId: opts.idempotencyKey, // second add with the same id is a no-op
      delay: opts.delayMs,
      attempts: opts.attempts,
      backoff: opts.backoff ? { type: opts.backoff.type, delay: opts.backoff.delayMs } : undefined,
      priority: opts.priority,
      removeOnComplete: true,
      removeOnFail: false, // keep failed jobs for inspection
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
    // Workers first: worker.close() drains in-flight jobs before queues close.
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

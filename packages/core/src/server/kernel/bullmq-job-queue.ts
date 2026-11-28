import { Queue, Worker, type ConnectionOptions, type Job, type JobsOptions } from 'bullmq';
import type {
  JobQueueAdapter,
  QueueName,
  EnqueueOptions,
  RepeatOptions,
  JobContext,
  WorkerRegistration,
} from '@openora/core/contracts';
import { createLogger } from './logger.js';

type AnyWorker = WorkerRegistration<unknown>;

const RETAIN_COMPLETED = { age: 24 * 60 * 60, count: 10_000 };
const RETAIN_FAILED = { age: 7 * 24 * 60 * 60, count: 10_000 };
const RETENTION = { removeOnComplete: RETAIN_COMPLETED, removeOnFail: RETAIN_FAILED };

const ERROR_LOG_INTERVAL_MS = 60_000;

const CLOSE_SETTLE_MS = 2_000;

type JobEnvelope = { payload: unknown; meta: Record<string, string | undefined> };

function toJobId(idempotencyKey: string): string {
  const encoded = idempotencyKey.replaceAll('%', '%25').replaceAll(':', '%3A');
  return /^\d+$/.test(encoded) ? `key-${encoded}` : encoded;
}

export class BullMqJobQueue implements JobQueueAdapter {
  private readonly logger = createLogger('bullmq-job-queue');
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<string, Queue<JobEnvelope>>();
  private readonly workers: Worker<JobEnvelope>[] = [];
  private readonly orderingWarned = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private redisErrorLoggedAt = Number.NEGATIVE_INFINITY;
  private mutedRedisErrors = 0;

  constructor(redisUrl: string) {
    this.connection = { url: redisUrl, maxRetriesPerRequest: null };
  }

  enqueue<T>(queue: QueueName, payload: T, opts: EnqueueOptions = {}): Promise<{ id: string }> {
    if (opts.orderingKey && !this.orderingWarned.has(queue)) {
      this.orderingWarned.add(queue);
      this.logger.warn(
        { queue },
        '[bullmq-job-queue] orderingKey is not honoured by this driver (no ordering groups in OSS BullMQ); jobs run unordered',
      );
    }

    const envelope: JobEnvelope = {
      payload,
      meta: { ...opts.meta, idempotencyKey: opts.idempotencyKey },
    };

    const jobOpts: JobsOptions = {
      jobId: opts.idempotencyKey ? toJobId(opts.idempotencyKey) : undefined,
      delay: opts.delayMs,
      attempts: opts.attempts,
      backoff: opts.backoff ? { type: opts.backoff.type, delay: opts.backoff.delayMs } : undefined,
      priority: opts.priority,
      ...RETENTION,
    };

    return this.track(
      this.getQueue(queue)
        .add(queue, envelope, jobOpts)
        .then((job) => ({ id: job.id ?? '' })),
    );
  }

  registerWorker<T>(registration: WorkerRegistration<T>): void {
    const reg = registration as AnyWorker;
    const queueName = registration.queue;

    const worker = new Worker<JobEnvelope>(
      queueName,
      async (job) => {
        const ctx: JobContext<unknown> = {
          id: job.id ?? '',
          name: queueName,
          payload: reg.schema.parse(job.data.payload),
          attempt: job.attemptsMade + 1,
          enqueuedAt: new Date(job.timestamp),
          meta: job.data.meta,
        };
        await reg.handler(ctx);
      },
      { connection: this.connection, concurrency: registration.options?.concurrency ?? 1 },
    );

    worker.on('error', (error) => this.logRedisError(queueName, error));
    worker.on('failed', (job, error) => {
      if (!job) {
        return;
      }
      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < maxAttempts) {
        return;
      }
      void this.deadLetter(reg, job, error);
    });

    this.workers.push(worker);
  }

  schedule<T>(
    queue: QueueName,
    scheduleId: string,
    payload: T,
    repeat: RepeatOptions,
  ): Promise<void> {
    const envelope: JobEnvelope = { payload, meta: {} };
    return this.track(
      this.getQueue(queue)
        .upsertJobScheduler(
          scheduleId,
          { pattern: repeat.cron, every: repeat.everyMs, tz: repeat.timezone },
          { name: queue, data: envelope, opts: RETENTION },
        )
        .then(() => undefined),
    );
  }

  unschedule(queue: QueueName, scheduleId: string): Promise<void> {
    return this.track(
      this.getQueue(queue)
        .removeJobScheduler(scheduleId)
        .then(() => undefined),
    );
  }

  async close(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.workers.map((w) => w.waitUntilReady()), ...this.pending]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLOSE_SETTLE_MS);
      }),
    ]);
    clearTimeout(timer);
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }

  private track<T>(write: Promise<T>): Promise<T> {
    this.pending.add(write);
    const settled = () => this.pending.delete(write);
    write.then(settled, settled);
    return write;
  }

  private getQueue(queue: QueueName): Queue<JobEnvelope> {
    const existing = this.queues.get(queue);
    if (existing) {
      return existing;
    }
    const created = new Queue<JobEnvelope>(queue, { connection: this.connection });
    created.on('error', (error) => this.logRedisError(queue, error));
    this.queues.set(queue, created);
    return created;
  }

  private logRedisError(queue: string, error: Error): void {
    const now = Date.now();
    if (now - this.redisErrorLoggedAt < ERROR_LOG_INTERVAL_MS) {
      this.mutedRedisErrors += 1;
      return;
    }
    this.logger.error(
      { queue, message: error.message, suppressed: this.mutedRedisErrors },
      '[bullmq-job-queue] redis error; further redis errors muted for 60s',
    );
    this.redisErrorLoggedAt = now;
    this.mutedRedisErrors = 0;
  }

  private async deadLetter(worker: AnyWorker, job: Job<JobEnvelope>, error: Error): Promise<void> {
    const ctx: JobContext<unknown> = {
      id: job.id ?? '',
      name: worker.queue,
      payload: job.data.payload,
      attempt: job.attemptsMade,
      enqueuedAt: new Date(job.timestamp),
      meta: job.data.meta,
    };
    this.logger.error(
      { queue: ctx.name, jobId: ctx.id, attempt: ctx.attempt, err: error },
      '[bullmq-job-queue] job exhausted retries -> dead-letter',
    );
    if (worker.onDeadLetter) {
      try {
        await worker.onDeadLetter(ctx, error);
      } catch (hookErr) {
        this.logger.error(
          { queue: ctx.name, jobId: ctx.id, err: hookErr },
          '[bullmq-job-queue] onDeadLetter hook threw',
        );
      }
    }
  }
}

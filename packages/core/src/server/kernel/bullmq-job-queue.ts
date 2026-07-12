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

// Durable JOB_QUEUE reference driver, bound by createApp when REDIS_URL is set -
// same auto-bind treatment as the Redis cache/rate-limiter (ADR-0028). Jobs survive
// a restart and cron runs for real, with zero consumer code. BullMQ is ioredis-based,
// so the node-redis client from redis-client.ts cannot be reused; BullMQ owns its own
// connections (one per Queue/Worker) built from the URL - closed on close().

type AnyWorker = WorkerRegistration<unknown>;

// The wire shape stored on every BullMQ job: the caller payload plus carried meta.
// The worker validates `payload` against the registration schema before the handler
// runs, exactly as the in-process driver does.
type JobEnvelope = { payload: unknown; meta: Record<string, string | undefined> };

/**
 * Durable `JOB_QUEUE` reference driver, auto-bound by `createApp` when
 * `REDIS_URL` is set - jobs survive a process restart and `cron`/`everyMs`
 * schedules run for real. `idempotencyKey` maps to the BullMQ `jobId`, so
 * BullMQ itself dedupes concurrent enqueues. `orderingKey` is NOT honoured
 * (OSS BullMQ has no per-key ordering groups) - jobs run unordered regardless
 * of the key, so every handler must be idempotent under any interleaving, not
 * just under retries. The `'failed'` listener only triggers the dead-letter
 * hook once `attemptsMade` reaches the job's own `attempts` (default 1) -
 * intermediate retry failures are silent by design. `close()` closes workers
 * before queues so in-flight jobs drain first.
 */
export class BullMqJobQueue implements JobQueueAdapter {
  private readonly logger = createLogger('bullmq-job-queue');
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<string, Queue<JobEnvelope>>();
  private readonly workers: Worker<JobEnvelope>[] = [];
  private readonly orderingWarned = new Set<string>();

  constructor(redisUrl: string) {
    // BullMQ requires maxRetriesPerRequest: null on the (blocking) worker connection.
    this.connection = { url: redisUrl, maxRetriesPerRequest: null };
  }

  enqueue<T>(queue: QueueName, payload: T, opts: EnqueueOptions = {}): Promise<{ id: string }> {
    if (opts.orderingKey && !this.orderingWarned.has(queue)) {
      this.orderingWarned.add(queue);
      // OSS BullMQ has no per-key ordering groups (a BullMQ Pro feature), so orderingKey
      // cannot serialize fan-in here; jobs run unordered. Handlers are required idempotent
      // anyway (at-least-once delivery, repo rule), so this degrades safely.
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
      // idempotencyKey -> jobId: BullMQ dedupes to one job per id.
      jobId: opts.idempotencyKey,
      delay: opts.delayMs,
      attempts: opts.attempts,
      backoff: opts.backoff ? { type: opts.backoff.type, delay: opts.backoff.delayMs } : undefined,
      priority: opts.priority,
      // ttlMs has no native BullMQ equivalent - ignored (the port allows driver variance).
    };

    return this.getQueue(queue)
      .add(queue, envelope, jobOpts)
      .then((job) => ({ id: job.id ?? '' }));
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
      // BullMQ rejects an explicit `concurrency: undefined`; default to 1 when unset.
      { connection: this.connection, concurrency: registration.options?.concurrency ?? 1 },
    );

    // 'failed' fires per attempt; act only once retries are exhausted (attemptsMade has
    // reached the job's own attempts, default 1) - mirrors the in-process dead-letter.
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
    return this.getQueue(queue)
      .upsertJobScheduler(
        scheduleId,
        { pattern: repeat.cron, every: repeat.everyMs, tz: repeat.timezone },
        { name: queue, data: envelope },
      )
      .then(() => undefined);
  }

  unschedule(queue: QueueName, scheduleId: string): Promise<void> {
    return this.getQueue(queue)
      .removeJobScheduler(scheduleId)
      .then(() => undefined);
  }

  async close(): Promise<void> {
    // Workers first (drain in-flight), then queues; each close() tears down its own
    // BullMQ-owned connection.
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }

  private getQueue(queue: QueueName): Queue<JobEnvelope> {
    const existing = this.queues.get(queue);
    if (existing) {
      return existing;
    }
    const created = new Queue<JobEnvelope>(queue, { connection: this.connection });
    this.queues.set(queue, created);
    return created;
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
      { queue: ctx.name, jobId: ctx.id, attempt: ctx.attempt, err: error.message },
      '[bullmq-job-queue] job exhausted retries -> dead-letter',
    );
    if (worker.onDeadLetter) {
      try {
        await worker.onDeadLetter(ctx, error);
      } catch (hookErr) {
        this.logger.error(
          { queue: ctx.name, jobId: ctx.id, err: String(hookErr) },
          '[bullmq-job-queue] onDeadLetter hook threw',
        );
      }
    }
  }
}

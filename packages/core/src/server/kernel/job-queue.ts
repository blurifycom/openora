import type { Logger } from 'pino';
import type {
  JobQueueAdapter,
  QueueName,
  EnqueueOptions,
  RepeatOptions,
  JobContext,
  WorkerRegistration,
} from '@openora/core/contracts';

// Zero-dependency in-process default. Swap to BullMQ overlay for persistence/cron. See ADR-0014.

type AnyWorker = WorkerRegistration<unknown>;

type InternalJob = {
  id: string;
  queue: QueueName;
  payload: unknown;
  opts: EnqueueOptions;
  enqueuedAt: Date;
};

function computeBackoffMs(opts: EnqueueOptions, attempt: number): number {
  const backoff = opts.backoff;
  if (!backoff) {
    return 0;
  }
  if (backoff.type === 'fixed') {
    return backoff.delayMs;
  }
  return backoff.delayMs * 2 ** (attempt - 1);
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

/**
 * Zero-dependency default `JOB_QUEUE` driver - process-local, non-durable (jobs
 * are lost on restart). `idempotencyKey` dedupes concurrent enqueues to a single
 * job id; `orderingKey` serializes execution into a per-key lane so jobs with
 * the same key never run concurrently or out of order (a lane failure is
 * swallowed so it can't poison later jobs on the same key). Retries run
 * in-process with the configured backoff; once `attempts` is exhausted the job
 * goes to `onDeadLetter` instead of throwing. `cron` repeat schedules are not
 * supported here (warns and is ignored) - only `everyMs` interval schedules
 * work; use the BullMQ driver for real cron. `close()` awaits every in-flight
 * job and lane before resolving.
 */
export class InProcessJobQueue implements JobQueueAdapter {
  private readonly workers = new Map<string, AnyWorker>();
  // Buffered until registerWorker fires (registration happens at boot, after providers).
  private readonly pending = new Map<string, InternalJob[]>();
  private readonly lanes = new Map<string, Promise<void>>();
  // job id per idempotency key - dedupes duplicate enqueues.
  private readonly activeKeys = new Map<string, string>();
  // Awaited on close() for a clean drain.
  private readonly inFlight = new Set<Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly schedules = new Map<string, ReturnType<typeof setInterval>>();
  private counter = 0;
  private closed = false;

  constructor(private readonly logger: Logger) {}

  enqueue<T>(queue: QueueName, payload: T, opts: EnqueueOptions = {}): Promise<{ id: string }> {
    if (this.closed) {
      throw new Error('[job-queue] enqueue after close()');
    }

    if (opts.idempotencyKey) {
      const existing = this.activeKeys.get(opts.idempotencyKey);
      if (existing) {
        return Promise.resolve({ id: existing });
      }
    }

    const id = `job-${++this.counter}`;
    if (opts.idempotencyKey) {
      this.activeKeys.set(opts.idempotencyKey, id);
    }

    const job: InternalJob = { id, queue, payload, opts, enqueuedAt: new Date() };

    if (opts.delayMs && opts.delayMs > 0) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.dispatch(job);
      }, opts.delayMs);
      t.unref?.();
      this.timers.add(t);
    } else {
      queueMicrotask(() => this.dispatch(job));
    }

    return Promise.resolve({ id });
  }

  registerWorker<T>(registration: WorkerRegistration<T>): void {
    this.workers.set(registration.queue, registration as AnyWorker);
    const buffered = this.pending.get(registration.queue);
    if (buffered) {
      this.pending.delete(registration.queue);
      for (const job of buffered) {
        this.dispatch(job);
      }
    }
  }

  schedule<T>(
    queue: QueueName,
    scheduleId: string,
    payload: T,
    repeat: RepeatOptions,
  ): Promise<void> {
    if (this.closed) {
      throw new Error('[job-queue] schedule after close()');
    }
    const key = `${queue}:${scheduleId}`;
    const existing = this.schedules.get(key);
    if (existing) {
      clearInterval(existing);
    }

    if (repeat.everyMs && repeat.everyMs > 0) {
      const interval = setInterval(() => {
        void this.enqueue(queue, payload);
      }, repeat.everyMs);
      interval.unref?.();
      this.schedules.set(key, interval);
    } else if (repeat.cron) {
      // Cron not supported in-process; a durable driver (BullMQ) provides real cron.
      // Warn so a misconfigured dev environment is loud, not silently broken.
      this.logger.warn(
        { queue, scheduleId, cron: repeat.cron },
        '[job-queue] cron schedules require a durable driver (BullMQ overlay); ignored in-process',
      );
    }
    return Promise.resolve();
  }

  unschedule(queue: QueueName, scheduleId: string): Promise<void> {
    const key = `${queue}:${scheduleId}`;
    const interval = this.schedules.get(key);
    if (interval) {
      clearInterval(interval);
      this.schedules.delete(key);
    }
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers.clear();
    for (const interval of this.schedules.values()) {
      clearInterval(interval);
    }
    this.schedules.clear();
    await Promise.allSettled([...this.inFlight, ...this.lanes.values()]);
  }

  private dispatch(job: InternalJob): void {
    const worker = this.workers.get(job.queue);
    if (!worker) {
      const buf = this.pending.get(job.queue) ?? [];
      buf.push(job);
      this.pending.set(job.queue, buf);
      return;
    }

    const orderingKey = job.opts.orderingKey;
    if (orderingKey) {
      const laneKey = `${job.queue}:${orderingKey}`;
      const prev = this.lanes.get(laneKey) ?? Promise.resolve();
      const next = prev.then(() => this.runJob(worker, job));
      // Swallow so one lane failure doesn't poison subsequent jobs on the same key.
      const settled = next.then(
        () => undefined,
        () => undefined,
      );
      this.lanes.set(laneKey, settled);
      void settled.finally(() => {
        if (this.lanes.get(laneKey) === settled) {
          this.lanes.delete(laneKey);
        }
      });
    } else {
      this.track(this.runJob(worker, job));
    }
  }

  private track(p: Promise<void>): void {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  private async runJob(worker: AnyWorker, job: InternalJob): Promise<void> {
    const attempts = Math.max(1, job.opts.attempts ?? 1);
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ctx: JobContext<unknown> = {
        id: job.id,
        name: job.queue,
        payload: job.payload,
        attempt,
        enqueuedAt: job.enqueuedAt,
        meta: { ...job.opts.meta, idempotencyKey: job.opts.idempotencyKey },
      };
      try {
        ctx.payload = worker.schema.parse(job.payload);
        await worker.handler(ctx);
        this.releaseKey(job);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < attempts) {
          await sleep(computeBackoffMs(job.opts, attempt));
          continue;
        }
        await this.deadLetter(worker, ctx, lastError);
        this.releaseKey(job);
        return;
      }
    }
  }

  private async deadLetter(
    worker: AnyWorker,
    ctx: JobContext<unknown>,
    error: Error,
  ): Promise<void> {
    this.logger.error(
      { queue: ctx.name, jobId: ctx.id, attempt: ctx.attempt, err: error },
      '[job-queue] job exhausted retries -> dead-letter',
    );
    if (worker.onDeadLetter) {
      try {
        await worker.onDeadLetter(ctx, error);
      } catch (hookErr) {
        this.logger.error(
          { queue: ctx.name, jobId: ctx.id, err: hookErr },
          '[job-queue] onDeadLetter hook threw',
        );
      }
    }
  }

  private releaseKey(job: InternalJob): void {
    if (job.opts.idempotencyKey && this.activeKeys.get(job.opts.idempotencyKey) === job.id) {
      this.activeKeys.delete(job.opts.idempotencyKey);
    }
  }
}

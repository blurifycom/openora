import type { Logger } from 'pino';
import type {
  JobQueueAdapter,
  QueueName,
  EnqueueOptions,
  RepeatOptions,
  JobContext,
  WorkerRegistration,
} from '@oss/adapters';

// Zero-dependency in-process JobQueueAdapter. This is the DEFAULT binding so the
// platform boots, seeds and tests with no Redis. A downstream operator binds a
// durable driver (the reference BullMQ overlay) to JOB_QUEUE to get persistence,
// cross-process workers and real cron. Behaviour parity with the durable driver:
// at-least-once, attempts + backoff, per-orderingKey serialization, dead-letter
// hook, graceful drain. See ADR-0014.

type AnyWorker = WorkerRegistration<unknown>;

interface InternalJob {
  id: string;
  queue: QueueName;
  payload: unknown;
  opts: EnqueueOptions;
  enqueuedAt: Date;
}

function computeBackoffMs(opts: EnqueueOptions, attempt: number): number {
  const backoff = opts.backoff;
  if (!backoff) return 0;
  if (backoff.type === 'fixed') return backoff.delayMs;
  // exponential: delayMs * 2^(attempt-1)
  return backoff.delayMs * 2 ** (attempt - 1);
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

export class InProcessJobQueue implements JobQueueAdapter {
  private readonly workers = new Map<string, AnyWorker>();
  // Jobs enqueued before their worker registered are buffered, then flushed on
  // registerWorker (worker registration happens at boot, after providers).
  private readonly pending = new Map<string, InternalJob[]>();
  // Per-orderingKey serial lanes: a job chains onto the prior job for its key.
  private readonly lanes = new Map<string, Promise<void>>();
  // Active idempotency keys -> the job id holding them (dedupe duplicate enqueues).
  private readonly activeKeys = new Map<string, string>();
  // In-flight work to await on close() for a clean drain.
  private readonly inFlight = new Set<Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly schedules = new Map<string, ReturnType<typeof setInterval>>();
  private counter = 0;
  private closed = false;

  constructor(private readonly logger: Logger) {}

  enqueue<T>(queue: QueueName, payload: T, opts: EnqueueOptions = {}): Promise<{ id: string }> {
    if (this.closed) throw new Error('[job-queue] enqueue after close()');

    // Dedupe: an active idempotency key short-circuits to the existing job.
    if (opts.idempotencyKey) {
      const existing = this.activeKeys.get(opts.idempotencyKey);
      if (existing) return Promise.resolve({ id: existing });
    }

    const id = `job-${++this.counter}`;
    if (opts.idempotencyKey) this.activeKeys.set(opts.idempotencyKey, id);

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
      for (const job of buffered) this.dispatch(job);
    }
  }

  schedule<T>(
    queue: QueueName,
    scheduleId: string,
    payload: T,
    repeat: RepeatOptions,
  ): Promise<void> {
    if (this.closed) throw new Error('[job-queue] schedule after close()');
    const key = `${queue}:${scheduleId}`;
    const existing = this.schedules.get(key);
    if (existing) clearInterval(existing);

    if (repeat.everyMs && repeat.everyMs > 0) {
      const interval = setInterval(() => {
        void this.enqueue(queue, payload);
      }, repeat.everyMs);
      interval.unref?.();
      this.schedules.set(key, interval);
    } else if (repeat.cron) {
      // Cron parsing is intentionally not bundled into the zero-dep default.
      // A durable driver (BullMQ) provides real cron; here we no-op with a warn
      // so a misconfigured dev environment is loud, not silently broken.
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
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const interval of this.schedules.values()) clearInterval(interval);
    this.schedules.clear();
    // Drain in-flight handlers (and their lane chains) before resolving.
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
      // Chain onto the prior job for this key so same-key jobs never interleave.
      const laneKey = `${job.queue}:${orderingKey}`;
      const prev = this.lanes.get(laneKey) ?? Promise.resolve();
      const next = prev.then(() => this.runJob(worker, job));
      // Swallow on the stored lane so one failure doesn't poison the chain.
      this.lanes.set(
        laneKey,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      // Tidy the lane map once this is the tail.
      void next.finally(() => {
        if (this.lanes.get(laneKey) === undefined) return;
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
        // Validate at the boundary (parse may coerce/narrow); a schema failure
        // is a normal failure that retries, then dead-letters.
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
      { queue: ctx.name, jobId: ctx.id, attempt: ctx.attempt, err: error.message },
      '[job-queue] job exhausted retries -> dead-letter',
    );
    if (worker.onDeadLetter) {
      try {
        await worker.onDeadLetter(ctx, error);
      } catch (hookErr) {
        this.logger.error(
          { queue: ctx.name, jobId: ctx.id, err: String(hookErr) },
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

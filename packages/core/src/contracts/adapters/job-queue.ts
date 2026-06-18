// Background-job seam. Modules enqueue durable, retryable, schedulable work
// through this adapter, so the queue driver is swappable: the default binding is
// an in-process queue (zero dependencies - good for `pnpm dev`, seed and tests);
// a downstream operator binds a durable driver (BullMQ/Redis is the reference
// overlay) to JOB_QUEUE without touching modules. Delivery is at-least-once, so
// handlers MUST be idempotent (use `idempotencyKey` + a DB guard for money jobs).
// Distinct from MESSAGE_BROKER: the broker is "something happened" fan-out (the
// EventBus facade); JOB_QUEUE is "execute this unit of work later, with delivery
// and retry control". See ADR-0014.
import { createToken, type Token } from './token.js';

// A queue name is a branded string so registrations and enqueues line up and a
// bare string can't be passed by accident.
export type QueueName = string & { readonly __brand: 'QueueName' };
export const queue = (name: string): QueueName => name as QueueName;

export type BackoffStrategy = { type: 'fixed' | 'exponential'; delayMs: number };

export type EnqueueOptions = {
  // Stable key -> at most one active job with this key (dedupe / idempotency).
  // Drivers map this to BullMQ's jobId. Required-by-convention for money jobs;
  // the handler must STILL guard duplicate execution with a DB unique constraint
  // (queue dedupe alone is insufficient across a partial commit + retry).
  idempotencyKey?: string;
  // Fan-in ordering: jobs sharing a key run in order, never concurrently
  // (per-wallet, per-bet). Cross-key jobs still parallelise.
  orderingKey?: string;
  delayMs?: number; // schedule this job for later
  attempts?: number; // total tries incl. the first (driver default if omitted)
  backoff?: BackoffStrategy;
  priority?: number; // lower = sooner; a driver may ignore it
  ttlMs?: number; // drop the job if not started within this window
  // Tracing/correlation metadata carried verbatim onto JobContext.meta.
  meta?: Record<string, string | undefined>;
};

export type RepeatOptions = {
  cron?: string; // eg '0 * * * *' (durable drivers only)
  everyMs?: number; // OR a fixed interval
  timezone?: string;
};

// Context handed to a worker handler. `payload` has already been validated by
// the registration's schema before the handler runs.
export type JobContext<T> = {
  id: string;
  name: QueueName;
  payload: T;
  attempt: number; // 1-based
  enqueuedAt: Date;
  // Carried metadata (correlationId, idempotencyKey) for tracing.
  meta: Record<string, string | undefined>;
};

export type JobHandler<T> = (ctx: JobContext<T>) => void | Promise<void>;

export type WorkerOptions = {
  concurrency?: number; // per-worker parallelism
  // Strict per-orderingKey serialization even when concurrency > 1.
  serializeByOrderingKey?: boolean;
};

// A minimal structural validator. A Zod schema (`ZodType<T>`) satisfies this, so
// callers pass their schema directly - but @oss/core/contracts stays zod-free (every
// other seam here imports nothing but ./token).
export type PayloadSchema<T> = {
  parse(data: unknown): T;
};

// What an overlay registers to start consuming a queue. The schema is the
// payload contract - validated before the handler runs, no vendor type leaks.
export type WorkerRegistration<T> = {
  queue: QueueName;
  schema: PayloadSchema<T>;
  handler: JobHandler<T>;
  options?: WorkerOptions;
  // Invoked after attempts are exhausted (post-dead-letter hook): alert, persist
  // the poison job, or trigger a compensating action. Never throws into the queue.
  onDeadLetter?: (ctx: JobContext<T>, error: Error) => void | Promise<void>;
};

export type JobQueueAdapter = {
  enqueue<T>(queue: QueueName, payload: T, opts?: EnqueueOptions): Promise<{ id: string }>;
  // Idempotent registration of a recurring schedule (keyed by queue + scheduleId).
  schedule<T>(
    queue: QueueName,
    scheduleId: string,
    payload: T,
    repeat: RepeatOptions,
  ): Promise<void>;
  unschedule(queue: QueueName, scheduleId: string): Promise<void>;
  // Start consuming a queue. Called once per worker overlay during boot.
  registerWorker<T>(registration: WorkerRegistration<T>): void;
  // Graceful drain: stop accepting, finish in-flight, close connections.
  close(): Promise<void>;
};

export const JOB_QUEUE: Token<JobQueueAdapter> = createToken('JOB_QUEUE');

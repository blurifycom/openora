import { createToken, type Token } from './token.js';

export type QueueName = string & { readonly __brand: 'QueueName' };
export const queue = (name: string): QueueName => name as QueueName;

export type BackoffStrategy = { type: 'fixed' | 'exponential'; delayMs: number };

export type EnqueueOptions = {
  idempotencyKey?: string;
  orderingKey?: string;
  delayMs?: number;
  attempts?: number;
  backoff?: BackoffStrategy;
  priority?: number;
  ttlMs?: number;
  meta?: Record<string, string | undefined>;
};

export type RepeatOptions = {
  cron?: string;
  everyMs?: number;
  timezone?: string;
};

export type JobContext<T> = {
  id: string;
  name: QueueName;
  payload: T;
  attempt: number;
  enqueuedAt: Date;
  meta: Record<string, string | undefined>;
};

export type JobHandler<T> = (ctx: JobContext<T>) => void | Promise<void>;

export type WorkerOptions = {
  concurrency?: number;
  serializeByOrderingKey?: boolean;
};

export type PayloadSchema<T> = {
  parse(data: unknown): T;
};

export type WorkerRegistration<T> = {
  queue: QueueName;
  schema: PayloadSchema<T>;
  handler: JobHandler<T>;
  options?: WorkerOptions;
  onDeadLetter?: (ctx: JobContext<T>, error: Error) => void | Promise<void>;
};

export type JobQueueAdapter = {
  enqueue<T>(queue: QueueName, payload: T, opts?: EnqueueOptions): Promise<{ id: string }>;
  schedule<T>(
    queue: QueueName,
    scheduleId: string,
    payload: T,
    repeat: RepeatOptions,
  ): Promise<void>;
  unschedule(queue: QueueName, scheduleId: string): Promise<void>;
  registerWorker<T>(registration: WorkerRegistration<T>): void;
  close(): Promise<void>;
};

export const JOB_QUEUE: Token<JobQueueAdapter> = createToken('JOB_QUEUE');

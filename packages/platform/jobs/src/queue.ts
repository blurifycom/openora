import type { JobsOptions } from 'bullmq';

export type { JobsOptions };

export type QueuePort = {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<void>;
};

export type WorkerHandler = (name: string, data: unknown) => Promise<void>;

export type WorkerPort = {
  process(name: string, handler: WorkerHandler): void;
};

export const QUEUE_NAMES: Record<string, string> = {};

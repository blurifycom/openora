import { randomUUID } from 'node:crypto';
import { DRIZZLE, EVENT_BUS } from '@openora/core/server';
import type { CoreTokenCatalog, EventHandler, Plugin, PluginContext } from '@openora/core/server';
import {
  IDENTITY_READER,
  JOB_QUEUE,
  REALTIME_TRANSPORT,
  type EnqueueOptions,
  type EventEnvelope,
  type JobContext,
  type JobQueueAdapter,
  type QueueName,
  type WorkerRegistration,
} from '@openora/core/contracts';
import { makeEventBus, makeIdentityReader, makeRealtimeTransport, mock } from './mock.js';
import type { TestDb } from './real-infra.js';

type EnqueuedJob = {
  queue: string;
  payload: unknown;
  opts: EnqueueOptions | undefined;
};

type HarnessOptions = {
  /** Container bindings on top of the plugin's required ports; `has` answers for these only. */
  ports?: ReadonlyArray<readonly [unknown, unknown]>;
  /** Run each enqueued job's worker at once (attempt 1), dropping a repeated idempotency key. */
  runEnqueuedJobs?: boolean;
};

/**
 * Registers `plugin` and runs its router factory against real Postgres, with the event bus,
 * identity reader, job queue and realtime transport doubled. Events are fired with a full
 * envelope; job workers either run inline on enqueue or are driven attempt by attempt through
 * `runJob` and `deadLetter`, the way the job queue would on a failure and its retry.
 */
export function bootPluginHarness(
  plugin: Plugin<CoreTokenCatalog>,
  db: TestDb,
  options: HarnessOptions = {},
) {
  const handlers = new Map<string, EventHandler[]>();
  const workers = new Map<string, WorkerRegistration<unknown>>();
  const enqueued: EnqueuedJob[] = [];
  const seenKeys = new Set<string>();
  const pending: Promise<unknown>[] = [];
  const routerFactories: ((c: unknown) => unknown)[] = [];

  const requireWorker = (queue: string) => {
    const worker = workers.get(queue);
    if (!worker) {
      throw new Error(`no worker registered for ${queue}`);
    }
    return worker;
  };
  const jobContext = (queue: string, payload: unknown, attempt: number): JobContext<unknown> => ({
    id: randomUUID(),
    name: queue as QueueName,
    payload: requireWorker(queue).schema.parse(payload),
    attempt,
    enqueuedAt: new Date(),
    meta: {},
  });

  const jobQueue = mock<JobQueueAdapter>({
    enqueue: (name: QueueName, payload: unknown, opts?: EnqueueOptions) => {
      enqueued.push({ queue: name, payload, opts });
      const key = opts?.idempotencyKey;
      const duplicate = Boolean(key && seenKeys.has(key));
      if (key) {
        seenKeys.add(key);
      }
      const run = (async () => {
        if (options.runEnqueuedJobs && !duplicate && workers.has(name)) {
          await requireWorker(name).handler(jobContext(name, payload, 1));
        }
        return { id: randomUUID() };
      })();
      pending.push(run);
      return run;
    },
    schedule: async () => undefined,
  });

  const ctx = mock<PluginContext<CoreTokenCatalog>>({
    provide: () => undefined,
    events: {
      on: (event: string, handler: EventHandler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    jobs: {
      worker: (registration: WorkerRegistration<unknown>) => {
        workers.set(registration.queue, registration);
      },
    },
    routers: {
      add: (_namespace: string, factory: (c: unknown) => unknown) => {
        routerFactories.push(factory);
      },
    },
  });
  plugin.register(ctx);

  const optional = new Map<unknown, unknown>(options.ports ?? []);
  const required = new Map<unknown, unknown>([
    [DRIZZLE, db.drizzle],
    [EVENT_BUS, makeEventBus()],
    [IDENTITY_READER, makeIdentityReader()],
    [JOB_QUEUE, jobQueue],
    [REALTIME_TRANSPORT, makeRealtimeTransport()],
  ]);
  const container = {
    get: (token: unknown) => (optional.has(token) ? optional.get(token) : required.get(token)),
    has: (token: unknown) => optional.has(token),
    onDispose: () => undefined,
  };
  for (const factory of routerFactories) {
    factory(container);
  }

  const fire = async (event: string, payload: unknown, eventId: string = randomUUID()) => {
    const envelope: EventEnvelope = {
      eventId,
      topic: event,
      payload,
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, envelope);
    }
    while (pending.length > 0) {
      await Promise.all(pending.splice(0));
    }
    return eventId;
  };

  const runJob = (queue: string, payload: unknown, attempt: number) =>
    requireWorker(queue).handler(jobContext(queue, payload, attempt));

  const deadLetter = async (queue: string, payload: unknown, attempt: number, error: Error) => {
    await requireWorker(queue).onDeadLetter?.(jobContext(queue, payload, attempt), error);
  };

  return { fire, runJob, deadLetter, enqueued };
}

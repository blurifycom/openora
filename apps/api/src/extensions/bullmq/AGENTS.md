# bullmq overlay

Durable `JOB_QUEUE` driver (BullMQ + Redis) - the reference real implementation of
the `JobQueueAdapter` seam (`@oss/adapters`, `job-queue.ts`). See ADR-0014.

## What it does

Rebinds the `JOB_QUEUE` token to `BullMqJobQueue`, giving the platform durable,
cross-process background jobs: persistence, native delayed + repeatable (cron) jobs,
retry + backoff, dead-letter, and concurrency. Replaces the zero-dependency
`InProcessJobQueue` default bound in `@oss/api-runtime`'s `create-app.ts`.

## Self-disabling

`register(ctx)` reads `REDIS_URL`. If unset it does nothing - the in-process default
stays in effect - so this entry is safe to leave in `extensions.config.ts` for
`pnpm dev`, tests and CI (no Redis required). Set `REDIS_URL` (eg
`redis://localhost:6379`, or `rediss://` for TLS) to activate.

## Mapping (seam -> BullMQ)

| Seam concept                               | BullMQ                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `enqueue(queue, payload, opts)`            | `queue.add(name, envelope, { jobId, delay, attempts, backoff, priority })` |
| `idempotencyKey`                           | `jobId` (a second add with the same id is a no-op)                         |
| `attempts` + `backoff` (fixed/exponential) | native `attempts` + `backoff`                                              |
| `delayMs`                                  | `delay`                                                                    |
| `schedule(cron/everyMs)`                   | `upsertJobScheduler(scheduleId, { pattern, every, tz })`                   |
| `registerWorker`                           | `new Worker(name, processor, { concurrency })`                             |
| `onDeadLetter`                             | `worker.on('failed')` once attempts are exhausted                          |
| `close()`                                  | `worker.close()` (drains active jobs) then `queue.close()`                 |

## Caveats

- Delivery is at-least-once. Handlers MUST be idempotent; money jobs need a DB unique
  guard in the same transaction (jobId dedupe alone is insufficient across a partial
  commit + retry).
- `orderingKey` is carried on the job envelope but strict per-key serialization is not
  enforced by the free BullMQ driver (requires concurrency 1 or BullMQ Pro groups).
  The in-process default DOES serialize by `orderingKey`.
- `ttlMs` is not enforced by this driver.

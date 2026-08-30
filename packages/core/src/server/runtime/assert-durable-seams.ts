import {
  MESSAGE_BROKER,
  JOB_QUEUE,
  CACHE,
  RATE_LIMITER,
  REALTIME_TRANSPORT,
  type AnyToken,
} from '@openora/core/contracts';

/**
 * Production is distributed-only (ADR-0030/0031, superseding ADR-0010/0014/0016/0028):
 * the in-process seam impls no longer ship on the production path, so every
 * always-needed seam must resolve to a durable binding before `createApp` finishes
 * booting. Call this AFTER `loadPlugins` + `configure` so a `REDIS_URL` auto-bind or
 * an overlay's own registration has already won (Container is last-registration-wins).
 * Modeled on `assertSealedServicesBound` (`compliance/assert.ts`) - same `has(token)`
 * shape, same "list every gap, don't stop at the first" style.
 *
 * `REALTIME_TRANSPORT` is included as of ADR-0031: `createApp` no longer binds an
 * in-process default (that was the exact silent-failure shape this guard exists to
 * catch - a single-instance deployment worked, a second replica behind a load
 * balancer silently stopped delivering to half its clients). An overlay (e.g. Ably)
 * still rebinds it via last-wins `container.register`, same as every other seam here.
 */
export type DurableSeamContainerView = {
  has(token: AnyToken<unknown>): boolean;
};

type SeamRequirement = { token: AnyToken<unknown>; name: string; fix: string };

const REQUIRED_DURABLE_SEAMS: readonly SeamRequirement[] = [
  {
    token: MESSAGE_BROKER,
    name: 'MESSAGE_BROKER',
    fix: 'set REDIS_URL to auto-bind RedisStreamsBroker, or bind a MessageBrokerAdapter overlay (eg RabbitMQ/Kafka) via ctx.provide(MESSAGE_BROKER, ...)',
  },
  {
    token: JOB_QUEUE,
    name: 'JOB_QUEUE',
    fix: 'set REDIS_URL to auto-bind BullMqJobQueue, or bind a JOB_QUEUE overlay directly',
  },
  {
    token: CACHE,
    name: 'CACHE',
    fix: 'set REDIS_URL to auto-bind RedisCache, or bind a CACHE overlay directly',
  },
  {
    token: RATE_LIMITER,
    name: 'RATE_LIMITER',
    fix: 'set REDIS_URL to auto-bind RedisRateLimiter, or bind a RATE_LIMITER overlay directly',
  },
  {
    token: REALTIME_TRANSPORT,
    name: 'REALTIME_TRANSPORT',
    fix: 'set REDIS_URL to auto-bind RedisPubSubRealtimeTransport, or bind a REALTIME_TRANSPORT overlay (eg Ably) directly',
  },
];

export function assertDurableSeamsBound(container: DurableSeamContainerView): void {
  const missing = REQUIRED_DURABLE_SEAMS.filter((seam) => !container.has(seam.token));
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `[create-app] production is distributed-only - the following seams have no durable binding:\n` +
      missing.map((seam) => `  - ${seam.name}: ${seam.fix}`).join('\n'),
  );
}

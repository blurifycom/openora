import {
  MESSAGE_BROKER,
  JOB_QUEUE,
  CACHE,
  RATE_LIMITER,
  REALTIME_TRANSPORT,
  type AnyToken,
} from '@openora/core/contracts';

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

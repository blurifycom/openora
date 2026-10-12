import { createRequire } from 'node:module';
import { arch, platform, version as nodeVersion } from 'node:process';
import {
  CACHE,
  JOB_QUEUE,
  PLAYER_ACTIVITY_TRACKER,
  queue,
  type PayloadSchema,
} from '@openora/core/contracts';
import { DRIZZLE, openoraInstance, type DrizzleService } from '../db/index.js';
import { createLogger, type Container } from '../kernel/index.js';
import type { CoreTokenCatalog } from './core-token-catalog.js';

export const TELEMETRY_DEFAULT_URL = 'https://telemetry.openora.ai/api/send';
export const TELEMETRY_DOCS_URL = 'https://openora.ai/documentation/telemetry';
// Public by design: an Umami website id ships in every browser tracking snippet.
// TODO: swap in the id of the telemetry website once it exists on the collector.
const UMAMI_WEBSITE_ID = '00000000-0000-0000-0000-000000000000';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEND_TIMEOUT_MS = 5000;
const TELEMETRY_QUEUE = queue('telemetry');
const HEARTBEAT_SCHEDULE_ID = 'telemetry.heartbeat';
const BOOT_GUARD_KEY = 'telemetry:boot';

const logger = createLogger('telemetry');
const corePackage: { version: string } = createRequire(import.meta.url)(
  '@openora/core/package.json',
);
const coreVersion = corePackage.version;

export type TelemetryEvent = 'boot' | 'heartbeat';
type Env = Record<string, string | undefined>;

export type TelemetryBody = {
  type: 'event';
  payload: {
    website: string;
    hostname: 'instance';
    url: `/${TelemetryEvent}`;
    name: TelemetryEvent;
    id: string;
    data: {
      version: string;
      node: string;
      os: string;
      arch: string;
      activePlayers1d: number | null;
      activePlayers30d: number | null;
    };
  };
};

const emptyPayload: PayloadSchema<Record<string, never>> = { parse: () => ({}) };

function isSet(flag: string | undefined): boolean {
  return flag !== undefined && ['1', 'true', 'yes'].includes(flag.trim().toLowerCase());
}

export function isTelemetryEnabled(option: false | undefined, env: Env = process.env): boolean {
  return (
    option !== false &&
    env['NODE_ENV'] !== 'test' &&
    !isSet(env['OPENORA_TELEMETRY_DISABLED']) &&
    !isSet(env['DO_NOT_TRACK'])
  );
}

export async function resolveInstanceId(drizzle: DrizzleService): Promise<string> {
  await drizzle.db.insert(openoraInstance).values({ singleton: true }).onConflictDoNothing();
  const [row] = await drizzle.db
    .select({ instanceId: openoraInstance.instanceId })
    .from(openoraInstance);
  if (!row) {
    throw new Error('openora_instance row missing after insert');
  }
  return row.instanceId;
}

export async function collectTelemetry(
  container: Container<CoreTokenCatalog>,
  event: TelemetryEvent,
  now = new Date(),
): Promise<TelemetryBody> {
  const tracker = container.has(PLAYER_ACTIVITY_TRACKER)
    ? container.get(PLAYER_ACTIVITY_TRACKER)
    : undefined;
  const countSince = (ms: number) =>
    tracker ? tracker.countActiveSince(new Date(now.getTime() - ms)).catch(() => null) : null;
  const [instanceId, activePlayers1d, activePlayers30d] = await Promise.all([
    resolveInstanceId(container.get(DRIZZLE)),
    countSince(DAY_MS),
    countSince(30 * DAY_MS),
  ]);
  return {
    type: 'event',
    payload: {
      website: UMAMI_WEBSITE_ID,
      hostname: 'instance',
      url: `/${event}`,
      name: event,
      id: instanceId,
      data: {
        version: coreVersion,
        node: nodeVersion,
        os: platform,
        arch,
        activePlayers1d,
        activePlayers30d,
      },
    },
  };
}

export async function sendTelemetry(url: string, body: TelemetryBody): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    // Umami drops requests whose user agent looks like a bot, which the default fetch one does.
    headers: { 'content-type': 'application/json', 'user-agent': `openora/${coreVersion} (node)` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`telemetry endpoint answered ${res.status}`);
  }
}

async function report(container: Container<CoreTokenCatalog>, event: TelemetryEvent, env: Env) {
  try {
    const body = await collectTelemetry(container, event);
    await sendTelemetry(env['OPENORA_TELEMETRY_URL'] ?? TELEMETRY_DEFAULT_URL, body);
    logger.debug({ body }, 'telemetry sent');
  } catch (err) {
    logger.warn({ err, event }, 'telemetry not sent');
  }
}

async function reportBoot(container: Container<CoreTokenCatalog>, env: Env) {
  try {
    const first = await container.get(CACHE).setIfAbsent(BOOT_GUARD_KEY, true, { ttlMs: HOUR_MS });
    if (first) {
      await report(container, 'boot', env);
    }
  } catch (err) {
    logger.warn({ err }, 'telemetry boot guard failed');
  }
}

export function startTelemetry(
  container: Container<CoreTokenCatalog>,
  option: false | undefined,
  env: Env = process.env,
): void {
  if (env['NODE_ENV'] === 'test') {
    return;
  }
  const jobQueue = container.get(JOB_QUEUE);
  if (!isTelemetryEnabled(option, env)) {
    // BullMQ keeps a job scheduler in Redis after the process that created it exits.
    void jobQueue
      .unschedule(TELEMETRY_QUEUE, HEARTBEAT_SCHEDULE_ID)
      .catch((err: unknown) => logger.warn({ err }, 'telemetry unschedule failed'));
    return;
  }
  logger.info(
    `Anonymous usage telemetry is on (instance id, version, active player counts). ` +
      `Set OPENORA_TELEMETRY_DISABLED=1 to turn it off. Details: ${TELEMETRY_DOCS_URL}`,
  );
  jobQueue.registerWorker({
    queue: TELEMETRY_QUEUE,
    schema: emptyPayload,
    handler: () => report(container, 'heartbeat', env),
  });
  void jobQueue
    .schedule(TELEMETRY_QUEUE, HEARTBEAT_SCHEDULE_ID, {}, { everyMs: DAY_MS })
    .catch((err: unknown) => logger.warn({ err }, 'telemetry schedule failed'));
  void reportBoot(container, env);
}

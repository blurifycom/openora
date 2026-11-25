import { parseArgs } from 'node:util';
import { createClient } from 'redis';
import { and, asc, eq, getTableColumns, gte, isNotNull, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { MessageBrokerAdapter } from '@openora/core/contracts';
import { EVENT_RETENTION_MS } from '../../kernel/event-bus.js';
import { RedisStreamsBroker } from '../../kernel/redis-streams-broker.js';
import { createPool, type DrizzleDb } from '../drizzle.js';
import { toEnvelope } from './relay.js';
import { eventOutbox } from './schema.js';

const USAGE =
  'usage: openora-outbox-replay --since <ISO time> [--topic <topic>] [--dry-run]\n' +
  'A plugin consumer drops an event it already applied (processed_events); a bare bus.on ' +
  'handler with no consumer name runs it again.';
const BATCH = 500;

class ReplayError extends Error {}

type ReplayOptions = { since: Date; topic?: string; dryRun?: boolean; now?: Date };

type ReplayReport = Map<string, number>;

type Cursor = { occurredAt: string; seq: number; eventId: string };

async function replayOutbox(
  db: DrizzleDb,
  broker: MessageBrokerAdapter | undefined,
  { since, topic, dryRun = false, now = new Date() }: ReplayOptions,
): Promise<ReplayReport> {
  const oldest = new Date(now.getTime() - EVENT_RETENTION_MS);
  if (since < oldest) {
    throw new ReplayError(
      `--since ${since.toISOString()} is older than the outbox retention (${oldest.toISOString()}): ` +
        'published rows before that are pruned, so the replay would be incomplete',
    );
  }
  const inRange = and(
    isNotNull(eventOutbox.publishedAt),
    gte(eventOutbox.publishedAt, since),
    topic === undefined ? undefined : eq(eventOutbox.topic, topic),
  );
  const report: ReplayReport = new Map();

  if (dryRun) {
    const rows = await db
      .select({ topic: eventOutbox.topic, n: sql<number>`count(*)::int` })
      .from(eventOutbox)
      .where(inRange)
      .groupBy(eventOutbox.topic)
      .orderBy(asc(eventOutbox.topic));
    for (const row of rows) {
      report.set(row.topic, row.n);
    }
    return report;
  }
  if (!broker) {
    throw new ReplayError('a replay needs a broker');
  }

  const seqKey = sql<number>`coalesce(${eventOutbox.seq}, -1)`;
  let cursor: Cursor | undefined;
  for (;;) {
    const after: SQL | undefined = cursor
      ? sql`(${eventOutbox.occurredAt}, ${seqKey}, ${eventOutbox.eventId}) > (${cursor.occurredAt}::timestamptz, ${cursor.seq}, ${cursor.eventId})`
      : undefined;
    const rows = await db
      .select({
        ...getTableColumns(eventOutbox),
        occurredAtText: sql<string>`${eventOutbox.occurredAt}::text`,
        seqKey,
      })
      .from(eventOutbox)
      .where(and(inRange, after))
      .orderBy(asc(eventOutbox.occurredAt), asc(seqKey), asc(eventOutbox.eventId))
      .limit(BATCH);
    for (const row of rows) {
      await broker.publish(toEnvelope(row));
      report.set(row.topic, (report.get(row.topic) ?? 0) + 1);
    }
    const last = rows.at(-1);
    if (!last || rows.length < BATCH) {
      return report;
    }
    cursor = { occurredAt: last.occurredAtText, seq: last.seqKey, eventId: last.eventId };
  }
}

type Flags = { since: Date; topic?: string; dryRun: boolean };

function parseFlags(argv: readonly string[]): Flags {
  let values: { since?: string; topic?: string; 'dry-run'?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        since: { type: 'string' },
        topic: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      strict: true,
    }));
  } catch {
    throw new ReplayError(USAGE);
  }
  const since = new Date(values.since ?? '');
  if (Number.isNaN(since.getTime())) {
    throw new ReplayError(`--since must be an ISO time\n${USAGE}`);
  }
  return {
    since,
    ...(values.topic === undefined ? {} : { topic: values.topic }),
    dryRun: values['dry-run'] === true,
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new ReplayError(`${name} is required`);
  }
  return value;
}

const say = (line: string) => process.stdout.write(`${line}\n`);

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  try {
    const { since, topic, dryRun } = parseFlags(argv);
    const pool = createPool(required(env, 'DATABASE_URL'));
    const db = drizzle(pool, { casing: 'snake_case' });
    const redis = dryRun
      ? undefined
      : createClient({ url: required(env, 'REDIS_URL'), socket: { reconnectStrategy: false } });
    try {
      await redis?.connect();
      const broker = redis && new RedisStreamsBroker(redis, { serviceName: 'outbox-replay' });
      const report = await replayOutbox(db, broker, {
        since,
        dryRun,
        ...(topic === undefined ? {} : { topic }),
      });
      let total = 0;
      for (const [name, count] of report) {
        say(`${name}: ${count}`);
        total += count;
      }
      say(`total: ${total} (${dryRun ? 'dry run, nothing published' : 'republished'})`);
      return 0;
    } finally {
      await redis?.quit().catch(() => undefined);
      await pool.end();
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : 'outbox-replay failed'}\n`);
    return 1;
  }
}

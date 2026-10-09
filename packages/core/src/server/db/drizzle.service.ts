import { createToken, type Token } from '@openora/core/contracts';
import type { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createPool } from './drizzle.js';
import { withReplicas } from 'drizzle-orm/pg-core';
import { createLogger } from '../kernel/logger.js';

export const DRIZZLE: Token<DrizzleService> = createToken('DRIZZLE');

/**
 * One primary pool plus optional read replicas (single-tenant, ADR-0026). Holds the
 * connections for the composition root.
 *
 * `db` is always the primary. `replica` sends plain selects to a replica listed in
 * `DATABASE_REPLICA_URLS` (the primary when none is set) and writes to the primary.
 * A replica lags, so it is opt-in: only for reads that tolerate stale rows (catalogs,
 * lists, reports), never for a gate, an idempotency check, or a read after a write.
 */
export class DrizzleService {
  private readonly pools: Pool[];
  readonly db: NodePgDatabase;
  readonly replica: NodePgDatabase;

  constructor() {
    const url = process.env['DATABASE_URL'];
    if (!url) {
      throw new Error('DATABASE_URL is required');
    }
    const replicaUrls = parseReplicaUrls(process.env['DATABASE_REPLICA_URLS']);

    this.pools = [url, ...replicaUrls].map(openPool);
    const [primary, ...replicas] = this.pools.map((pool) =>
      drizzle(pool, { casing: 'snake_case' }),
    );
    this.db = primary;
    this.replica = isNonEmpty(replicas) ? withReplicas(primary, replicas) : primary;
  }

  async dispose(): Promise<void> {
    await Promise.all(this.pools.map((pool) => pool.end()));
  }
}

function openPool(connectionString: string): Pool {
  const pool = createPool(connectionString);
  // A pg Pool emits 'error' when an idle backend connection dies (DB restart,
  // failover, network drop). With no listener Node escalates it to an
  // uncaughtException and crashes the process, so log it - which reports it via
  // the error reporter - and let the pool re-establish on the next query.
  pool.on('error', (err) => {
    createLogger('db').error({ err }, 'idle database pool connection error');
  });
  return pool;
}

export function parseReplicaUrls(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isNonEmpty<T>(items: T[]): items is [T, ...T[]] {
  return items.length > 0;
}

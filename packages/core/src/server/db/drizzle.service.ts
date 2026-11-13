import {
  createSealedToken,
  createToken,
  type SealedToken,
  type Token,
} from '@openora/core/contracts';
import type { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createPool, type PoolMax } from './drizzle.js';
import { withReplicas } from 'drizzle-orm/pg-core';
import { createLogger } from '../kernel/logger.js';

export const DRIZZLE: Token<DrizzleService> = createToken('DRIZZLE');

/**
 * The database that holds the audit chain (`audit_log`). Only the audit module binds it: a pool of
 * its own on `AUDIT_DATABASE_URL` when that is set, the `DRIZZLE` service itself otherwise. Sealed,
 * so no overlay can point the chain somewhere else. `audit_outbox` always stays in `DRIZZLE`.
 */
export const AUDIT_DRIZZLE: SealedToken<DrizzleService> =
  createSealedToken<DrizzleService>('AUDIT_DRIZZLE');

/**
 * The main database as the audit shipper reaches it to delete what it shipped from `audit_outbox`.
 * With the chain in its own database, a pool of its own on `AUDIT_SHIPPER_DATABASE_URL`, the one
 * role the outbox guard lets delete there; the `DRIZZLE` service itself otherwise. Sealed, like
 * `AUDIT_DRIZZLE`.
 */
export const AUDIT_SHIPPER_DRIZZLE: SealedToken<DrizzleService> =
  createSealedToken<DrizzleService>('AUDIT_SHIPPER_DRIZZLE');

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

  /**
   * `url` opens that database alone, without replicas; omitted, `DATABASE_URL` and its replicas.
   * `poolMax` sizes each pool by another env variable than `DATABASE_POOL_MAX`.
   */
  constructor(url?: string, { poolMax }: { poolMax?: PoolMax } = {}) {
    const primaryUrl = url ?? process.env['DATABASE_URL'];
    if (!primaryUrl) {
      throw new Error('DATABASE_URL is required');
    }
    const replicaUrls = url ? [] : parseReplicaUrls(process.env['DATABASE_REPLICA_URLS']);

    this.pools = [primaryUrl, ...replicaUrls].map((pooled) => openPool(pooled, poolMax));
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

function openPool(connectionString: string, poolMax?: PoolMax): Pool {
  const pool = createPool(connectionString, poolMax);
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

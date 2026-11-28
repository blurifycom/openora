import {
  createSealedToken,
  createToken,
  type SealedToken,
  type Token,
} from '@openora/core/contracts';
import type { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createPool, type PoolSizeEnv } from './drizzle.js';
import { withReplicas } from 'drizzle-orm/pg-core';
import { createLogger } from '../kernel/logger.js';

export const DRIZZLE: Token<DrizzleService> = createToken('DRIZZLE');

export const AUDIT_DRIZZLE: SealedToken<DrizzleService> =
  createSealedToken<DrizzleService>('AUDIT_DRIZZLE');

export const AUDIT_SHIPPER_DRIZZLE: SealedToken<DrizzleService> =
  createSealedToken<DrizzleService>('AUDIT_SHIPPER_DRIZZLE');

export class DrizzleService {
  private readonly pools: Pool[];
  readonly db: NodePgDatabase;
  readonly replica: NodePgDatabase;

  constructor(url?: string, { poolSize }: { poolSize?: PoolSizeEnv } = {}) {
    const primaryUrl = url ?? process.env['DATABASE_URL'];
    if (!primaryUrl) {
      throw new Error('DATABASE_URL is required');
    }
    const replicaUrls = url ? [] : parseReplicaUrls(process.env['DATABASE_REPLICA_URLS']);

    this.pools = [primaryUrl, ...replicaUrls].map((pooled) => openPool(pooled, poolSize));
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

function openPool(connectionString: string, poolSize?: PoolSizeEnv): Pool {
  const pool = createPool(connectionString, poolSize);
  pool.on('error', (err) => {
    createLogger('db').error({ err }, 'idle database pool connection error');
  });
  return pool;
}

function parseReplicaUrls(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isNonEmpty<T>(items: T[]): items is [T, ...T[]] {
  return items.length > 0;
}

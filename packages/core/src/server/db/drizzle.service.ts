import { createToken, type Token } from '@openora/core/contracts';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createLogger } from '../kernel/logger.js';

export const DRIZZLE: Token<DrizzleService> = createToken('DRIZZLE');

/** One pool, one db (single-tenant, ADR-0026). Holds the connection for the composition root. */
export class DrizzleService {
  private readonly pool: Pool;
  readonly db: NodePgDatabase;

  constructor() {
    const url = process.env['DATABASE_URL'];
    if (!url) {
      throw new Error('DATABASE_URL is required');
    }
    this.pool = new Pool({ connectionString: url });
    // A pg Pool emits 'error' when an idle backend connection dies (DB restart,
    // failover, network drop). With no listener Node escalates it to an
    // uncaughtException and crashes the process, so log it - which reports it via
    // the error reporter - and let the pool re-establish on the next query.
    this.pool.on('error', (err) => {
      createLogger('db').error({ err }, 'idle database pool connection error');
    });
    this.db = drizzle(this.pool, { casing: 'snake_case' });
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}

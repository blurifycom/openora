import { createToken, type Token } from '@openora/core/contracts';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

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
    this.db = drizzle(this.pool, { casing: 'snake_case' });
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}

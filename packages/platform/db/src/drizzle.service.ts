import { createToken, type Token } from '@oss/adapters';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

export const DRIZZLE: Token<DrizzleService> = createToken('DRIZZLE');

export class DrizzleService {
  readonly db: NodePgDatabase;
  private readonly pool: Pool;

  constructor() {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is required');
    this.pool = new Pool({ connectionString: url });
    this.db = drizzle(this.pool);
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

@Injectable()
export class DrizzleService implements OnModuleDestroy {
  readonly db: NodePgDatabase;
  private readonly pool: Pool;

  constructor() {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is required');
    this.pool = new Pool({ connectionString: url });
    this.db = drizzle(this.pool);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

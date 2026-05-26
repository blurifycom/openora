import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

export type DrizzleDb = NodePgDatabase;

export function createDrizzleDb(connectionString?: string): DrizzleDb {
  const url = connectionString ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  return drizzle(new Pool({ connectionString: url }));
}

export async function setTenantId(db: DrizzleDb, tenantId: string): Promise<void> {
  await db.execute(sql`SET app.tenant_id = ${tenantId}`);
}

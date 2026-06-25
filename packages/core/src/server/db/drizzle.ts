import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

export type DrizzleDb = NodePgDatabase;

export function createDrizzleDb(connectionString?: string): DrizzleDb {
  const url = connectionString ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  return drizzle(new Pool({ connectionString: url }), { casing: 'snake_case' });
}

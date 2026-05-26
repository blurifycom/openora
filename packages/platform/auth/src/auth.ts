import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import type { DrizzleDb } from '@oss/db';

export type AuthOptions = {
  db: DrizzleDb;
  schema?: Record<string, unknown>;
};

export function createAuth(options: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: options.schema,
    }),
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

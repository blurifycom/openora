import { betterAuth } from 'better-auth';
import type { Auth as BetterAuthType } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, admin as adminPlugin } from 'better-auth/plugins';
import type { DrizzleDb } from '@oss/db';
import { ac, roles } from './permissions.js';

export type AuthOptions = {
  db: DrizzleDb;
  schema?: Record<string, unknown>;
};

// Return type is explicit to avoid TS2883 (Zod v4 $strip portability issue with admin plugin)
export function createAuth(options: AuthOptions): BetterAuthType {
  return betterAuth({
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: options.schema,
    }),
    emailAndPassword: { enabled: true },
    plugins: [organization(), adminPlugin({ ac, roles })],
  }) as unknown as BetterAuthType;
}

export type Auth = BetterAuthType;

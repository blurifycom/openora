import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { Pool } from 'pg';

export type RunMigrationsOptions = {
  migrationsFolder: string;
  migrationsTable?: string;
  migrationsSchema?: string;
  databaseUrl?: string;
  migrationHashAliases?: Readonly<Record<string, readonly string[]>>;
  extensions?: string[];
  preSql?: string[];
  lockedPreSql?: string[];
  postSql?: string[];
  lockTimeout?: string;
};

const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export function appendOnlyTableSql(
  table: string,
  {
    mutableColumns,
    setOnceColumns = [],
    terminal,
    transitions = [],
  }: {
    mutableColumns: string[];
    setOnceColumns?: string[];
    transitions?: { column: string; allowed: readonly (readonly [string | null, string])[] }[];
    terminal?: {
      column: string;
      values: string[];
      growOnly?: string[];
      growOnlyTotals?: string[][];
    };
  },
): string {
  const columns = [...mutableColumns, ...setOnceColumns];
  for (const name of [
    table,
    ...columns,
    ...(terminal
      ? [
          terminal.column,
          ...terminal.values,
          ...(terminal.growOnly ?? []),
          ...(terminal.growOnlyTotals ?? []).flat(),
        ]
      : []),
    ...transitions.flatMap(({ column, allowed }) => [
      column,
      ...allowed.flatMap(([from, to]) => (from === null ? [to] : [from, to])),
    ]),
  ]) {
    if (!SQL_IDENTIFIER.test(name)) {
      throw new Error(`Invalid SQL identifier: ${name}`);
    }
  }
  for (const { column } of transitions) {
    if (!mutableColumns.includes(column)) {
      throw new Error(`${table}: transition column ${column} must be one of its mutableColumns`);
    }
  }
  const exempt = `ARRAY[${columns.map((column) => `'${column}'`).join(', ')}]::text[]`;
  const setOnceChecks = setOnceColumns
    .map(
      (
        column,
      ) => `IF OLD.${column} IS NOT NULL AND NEW.${column} IS DISTINCT FROM OLD.${column} THEN
       RAISE EXCEPTION '${table} is append-only: ${column} cannot change once set';
     END IF;`,
    )
    .join('\n     ');
  const terminalChecks = terminal
    ? `IF OLD.${terminal.column}::text = ANY(ARRAY[${terminal.values.map((value) => `'${value}'`).join(', ')}]) THEN
       IF NEW.${terminal.column} IS DISTINCT FROM OLD.${terminal.column} THEN
         RAISE EXCEPTION '${table} is append-only: ${terminal.column} cannot change once final';
       END IF;
       ${(terminal.growOnly ?? [])
         .map(
           (column) => `IF NEW.${column} < OLD.${column} THEN
         RAISE EXCEPTION '${table} is append-only: ${column} cannot decrease once final';
       END IF;`,
         )
         .join('\n       ')}
       ${(terminal.growOnlyTotals ?? [])
         .map((group) => {
           const sum = (row: 'NEW' | 'OLD') =>
             group.map((column) => `${row}.${column}`).join(' + ');
           const negatives = group
             .map(
               (column) => `IF NEW.${column} < 0 THEN
         RAISE EXCEPTION '${table} is append-only: ${column} cannot be negative once final';
       END IF;`,
             )
             .join('\n       ');
           return `${negatives}
       IF ${sum('NEW')} < ${sum('OLD')} THEN
         RAISE EXCEPTION '${table} is append-only: ${group.join(' + ')} cannot decrease once final';
       END IF;`;
         })
         .join('\n       ')}
     END IF;`
    : '';
  const transitionChecks = transitions
    .map(({ column, allowed }) => {
      const permitted = allowed
        .map(([from, to]) =>
          from === null
            ? `(OLD.${column} IS NULL AND NEW.${column}::text IS NOT DISTINCT FROM '${to}')`
            : `(OLD.${column}::text IS NOT DISTINCT FROM '${from}' AND NEW.${column}::text IS NOT DISTINCT FROM '${to}')`,
        )
        .join(' OR ');
      return `IF NEW.${column} IS DISTINCT FROM OLD.${column} AND NOT (${permitted || 'false'}) THEN
       RAISE EXCEPTION '${table} is append-only: ${column} cannot change from % to %', OLD.${column}, NEW.${column};
     END IF;`;
    })
    .join('\n     ');
  const createTriggerIfMissing = (name: string, timing: string, each: string, fn: string) =>
    `IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${table}'::regclass AND tgname = '${name}') THEN
       CREATE TRIGGER ${name} BEFORE ${timing} ON ${table} FOR EACH ${each} EXECUTE FUNCTION ${fn}();
     END IF;`;
  return `CREATE OR REPLACE FUNCTION ${table}_deny_delete() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION '${table} is append-only: % is not permitted', TG_OP;
   END;
   $$;
   CREATE OR REPLACE FUNCTION ${table}_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF to_jsonb(NEW) - ${exempt} IS DISTINCT FROM to_jsonb(OLD) - ${exempt} THEN
       RAISE EXCEPTION '${table} is append-only: UPDATE may change only ${columns.join(', ')}';
     END IF;
     ${setOnceChecks}
     ${terminalChecks}
     ${transitionChecks}
     RETURN NEW;
   END;
   $$;
   DO $$
   BEGIN
     ${createTriggerIfMissing(`${table}_append_only_delete`, 'DELETE', 'STATEMENT', `${table}_deny_delete`)}
     ${createTriggerIfMissing(`${table}_append_only_update`, 'UPDATE', 'ROW', `${table}_guard_update`)}
   END
   $$`;
}

function migrateUrl(override?: string): string {
  const url = override ?? process.env['DATABASE_ADMIN_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('Cannot run migrations: set DATABASE_URL (or DATABASE_ADMIN_URL).');
  }
  return url;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

type SqlClient = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
};

export async function withMigrationAdvisoryLock<T>(
  client: SqlClient,
  lockName: string,
  action: () => Promise<T>,
) {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
  try {
    return await action();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
  }
}

export async function applyMigrationsIndividually({
  migrations,
  apply,
}: {
  migrations: MigrationMeta[];
  apply: (migration: MigrationMeta) => Promise<void>;
}) {
  for (const migration of migrations) {
    await apply(migration);
  }
}

export async function runMigrations(opts: RunMigrationsOptions) {
  if (opts.lockTimeout !== undefined && !/^\d+(ms|s|min)$/.test(opts.lockTimeout)) {
    throw new Error(`Invalid lock timeout: ${opts.lockTimeout}`);
  }
  const pool = new Pool({ connectionString: migrateUrl(opts.databaseUrl) });
  try {
    for (const ext of opts.extensions ?? []) {
      if (!/^[a-z0-9_]+$/.test(ext)) {
        throw new Error(`Invalid extension name: ${ext}`);
      }
      await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    for (const sql of opts.preSql ?? []) {
      await pool.query(sql);
    }
    const migrationsTable = opts.migrationsTable ?? '__drizzle_migrations';
    const migrationsSchema = opts.migrationsSchema ?? 'drizzle';
    const migrationConfig = {
      migrationsFolder: opts.migrationsFolder,
      migrationsTable,
      migrationsSchema,
    };
    const schema = quoteIdentifier(migrationsSchema);
    const table = quoteIdentifier(migrationsTable);
    const lockClient = await pool.connect();
    try {
      await withMigrationAdvisoryLock(
        lockClient,
        `${migrationsSchema}.${migrationsTable}`,
        async () => {
          await lockClient.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
          await lockClient.query(
            `CREATE TABLE IF NOT EXISTS ${schema}.${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
          );
          for (const sql of opts.lockedPreSql ?? []) {
            await lockClient.query(sql);
          }
          const applied = await lockClient.query<{ hash: string }>(
            `SELECT hash FROM ${schema}.${table}`,
          );
          const appliedHashes = new Set(applied.rows.map(({ hash }) => hash));
          for (const hash of appliedHashes) {
            for (const alias of opts.migrationHashAliases?.[hash] ?? []) {
              appliedHashes.add(alias);
            }
          }
          const pending = readMigrationFiles(migrationConfig).filter(
            (migration) => !appliedHashes.has(migration.hash),
          );
          await applyMigrationsIndividually({
            migrations: pending,
            apply: async (migration) => {
              const client = await pool.connect();
              try {
                await client.query('BEGIN');
                if (opts.lockTimeout) {
                  await client.query(`SET LOCAL lock_timeout = '${opts.lockTimeout}'`);
                }
                for (const statement of migration.sql) {
                  await client.query(statement);
                }
                await client.query(
                  `INSERT INTO ${schema}.${table} (hash, created_at) VALUES ($1, $2)`,
                  [migration.hash, migration.folderMillis],
                );
                await client.query('COMMIT');
              } catch (error) {
                await client.query('ROLLBACK');
                throw error;
              } finally {
                client.release();
              }
            },
          });
          for (const sql of opts.postSql ?? []) {
            await pool.query(sql);
          }
        },
      );
    } finally {
      lockClient.release();
    }
  } finally {
    await pool.end();
  }
}

export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./outbox/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_outbox',
    migrationsSchema: 'drizzle',
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}

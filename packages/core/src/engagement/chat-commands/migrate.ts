// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

const STRIPED_TRAUMA_HASH = 'a58ec63c81a4cbd62603a8381da61c5c6d85b57af5d56ba79839d090fbcf0708';
const DAFFY_LADY_BULLSEYE_HASH = 'be7cb45e281e24fa603be9ab2bbed52ea8038718e553419eedbeb6bb511a4324';
const STURDY_BARRACUDA_HASH = 'b88bbf595351156e39dc2322711d24dc0e94575356dbd7d16d837042d960decd';

export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_chat_commands',
    migrationsSchema: 'drizzle',
    migrationHashAliases: {
      [STRIPED_TRAUMA_HASH]: [DAFFY_LADY_BULLSEYE_HASH, STURDY_BARRACUDA_HASH],
    },
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}

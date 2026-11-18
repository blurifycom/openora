#!/usr/bin/env node
// First run on a fresh checkout: `.env`, Postgres + Redis, schema, then local data with an admin.
// Safe to re-run (it resets demo data and the admin password). Local databases only.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres']);
const SECRET_KEYS = ['AUTH_SECRET', 'WITHDRAWAL_PIN_HMAC_SECRET'];
const HINTS = {
  'docker compose up -d --wait':
    'Is port 5432 or 6379 taken? Set POSTGRES_PORT / REDIS_PORT and the matching DATABASE_URL / REDIS_URL in .env.',
  'pnpm db:migrate': 'Check DATABASE_URL in .env points at the Docker Postgres.',
  'pnpm db:seed': 'Check DATABASE_URL in .env points at the Docker Postgres.',
};

const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};
const run = (command) => {
  try {
    execSync(command, { stdio: 'inherit' });
  } catch {
    fail(`\`${command}\` failed (output above). ${HINTS[command]}`);
  }
};

// Fill any empty or missing secret, so a new .env and one copied by hand both get real keys.
const original = existsSync('.env') ? readFileSync('.env', 'utf8') : null;
let env = original ?? readFileSync('.env.example', 'utf8');
for (const key of SECRET_KEYS) {
  const line = new RegExp(`^${key}=[ \\t]*$`, 'm');
  if (line.test(env)) env = env.replace(line, `${key}=${randomBytes(32).toString('base64')}`);
  else if (!new RegExp(`^${key}=`, 'm').test(env))
    env += `\n${key}=${randomBytes(32).toString('base64')}\n`;
}
if (env !== original) {
  writeFileSync('.env', env, { mode: 0o600 });
  console.log(
    original === null ? 'Created .env with fresh secrets.' : 'Added missing secrets to .env.',
  );
}

// Shell env wins over .env, the same way `pnpm db:migrate` resolves it.
process.loadEnvFile('.env');
if (process.env.NODE_ENV === 'production') fail('Refusing to bootstrap with NODE_ENV=production.');
let databaseUrl;
try {
  databaseUrl = new URL(process.env.DATABASE_URL ?? '');
} catch {
  fail('DATABASE_URL in .env is missing or not a valid postgres URL.');
}
const host = databaseUrl.searchParams.get('host') ?? databaseUrl.hostname;
if (!LOCAL_DB_HOSTS.has(host)) {
  fail(
    `Refusing to bootstrap the database at ${host}: it migrates and wipes demo data. Point DATABASE_URL at the local Docker Postgres.`,
  );
}

try {
  execSync('docker info', { stdio: 'ignore' });
} catch {
  fail('Docker is not running. Install Docker Desktop, start it, then run `pnpm bootstrap` again.');
}

run('docker compose up -d --wait');
run('pnpm db:migrate');
run('pnpm db:seed');

console.log(`
Ready. Start the API with \`pnpm dev\`, then open http://localhost:3001/docs.
The backoffice admin login is printed above (ADMIN_EMAIL / ADMIN_PASSWORD in .env).`);

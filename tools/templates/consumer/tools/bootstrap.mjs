#!/usr/bin/env node
// First run on a fresh checkout: `.env`, Postgres + Redis, schema, then local data with an admin.
// Safe to re-run. Run via `pnpm bootstrap`, then `pnpm dev`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const run = (command) => execSync(command, { stdio: 'inherit' });

if (!existsSync('.env')) {
  const secret = () => randomBytes(32).toString('base64');
  const env = readFileSync('.env.example', 'utf8')
    .replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret()}`)
    .replace(/^WITHDRAWAL_PIN_HMAC_SECRET=.*$/m, `WITHDRAWAL_PIN_HMAC_SECRET=${secret()}`);
  writeFileSync('.env', env);
  console.log('Created .env from .env.example with fresh secrets.');
}

try {
  execSync('docker info', { stdio: 'ignore' });
} catch {
  console.error(
    'Docker is not running. Install Docker Desktop, start it, then run `pnpm bootstrap` again.',
  );
  process.exit(1);
}

run('docker compose up -d --wait');
run('pnpm db:migrate');
run('pnpm db:seed');

console.log(`
Ready. Start the API with \`pnpm dev\`, then open http://localhost:3001/docs.
The backoffice admin login is printed above (ADMIN_EMAIL / ADMIN_PASSWORD in .env).`);

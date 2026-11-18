#!/usr/bin/env bash
# What a new user does, against this checkout's unpublished packages: scaffold an app in an
# empty folder, `pnpm install`, `pnpm bootstrap` (twice: it must be re-runnable), start the API
# and log in as the seeded admin. Needs Docker. Run from the repo root: `pnpm test:consumer`.
# POSTGRES_PORT / REDIS_PORT / API_PORT move the stack off ports another local stack holds.
set -euo pipefail

ROOT=$(pwd)
OUT=$(mktemp -d)
POSTGRES_PORT=${POSTGRES_PORT:-5432}
REDIS_PORT=${REDIS_PORT:-6379}
API_PORT=${API_PORT:-3001}
APP="$OUT/app"

# Shell env wins over the app's .env, so these pin the app to its own stack. CI's test-DB
# variables are dropped: migrate prefers DATABASE_ADMIN_URL over DATABASE_URL.
unset DATABASE_ADMIN_URL TEST_DATABASE_URL TEST_ADMIN_DATABASE_URL TEST_REDIS_URL
export OPENORA_TELEMETRY_DISABLED=1
export COMPOSE_PROJECT_NAME=consumer-e2e POSTGRES_PORT REDIS_PORT
export DATABASE_URL="postgresql://postgres:postgres@localhost:$POSTGRES_PORT/oss_igaming"
export REDIS_URL="redis://localhost:$REDIS_PORT"

cleanup() {
  # pnpm wraps the API process, so stop whatever holds the port.
  [ -n "${healthy:-}" ] && lsof -ti "tcp:$API_PORT" -sTCP:LISTEN | xargs kill 2> /dev/null || true
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2> /dev/null || true
  [ -d "$APP" ] && (cd "$APP" && docker compose down -v > /dev/null 2>&1) || true
  rm -rf "$OUT"
}
trap cleanup EXIT

pnpm --filter @openora/core --filter @openora/create build
(cd packages/core && pnpm pack --pack-destination "$OUT")
(cd packages/create-openora && pnpm pack --pack-destination "$OUT")

cd "$OUT"
node "$ROOT/packages/create-openora/dist/index.js" app --no-telemetry
cd "$APP"
if grep -rnE '\{\{[A-Za-z0-9_]+\}\}' --exclude-dir=node_modules . ; then
  echo 'Unrendered template placeholders above.' && exit 1
fi
# Resolve @openora/* from the packed tarballs instead of npm.
cat >> pnpm-workspace.yaml << EOF
overrides:
  '@openora/core': 'file:$(ls "$OUT"/openora-core-*.tgz)'
  '@openora/create': 'file:$(ls "$OUT"/openora-create-*.tgz)'
EOF
pnpm install

pnpm bootstrap
pnpm bootstrap

PORT=$API_PORT pnpm -F @app/api start > "$OUT/api.log" 2>&1 &
API_PID=$!
healthy=
for _ in $(seq 1 120); do
  curl -sf "http://localhost:$API_PORT/health" > /dev/null && healthy=1 && break
  kill -0 "$API_PID" 2> /dev/null || break
  sleep 1
done
[ -n "$healthy" ] || { echo 'API never became healthy.'; tail -40 "$OUT/api.log"; exit 1; }
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$API_PORT/identity/login" \
  -H 'content-type: application/json' -d '{"email":"admin@oss.dev","password":"password1234"}')
echo "admin login: HTTP $status"
[ "$status" = 200 ] || { tail -40 "$OUT/api.log"; exit 1; }

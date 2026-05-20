#!/bin/sh
set -e

# Apply Prisma schema before starting the API. Idempotent for dev/demo. For
# production, swap to `prisma migrate deploy` in a separate one-shot container.
#
# PRISMA_DIR points at the dir containing prisma.config.ts (defaults to ./infra).
# RUN_MIGRATIONS=false skips the push (e.g. when a CI step already ran it).

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  PRISMA_DIR="${PRISMA_DIR:-infra}"
  echo "[entrypoint] applying Prisma schema from $PRISMA_DIR to $DATABASE_URL"
  (cd "$PRISMA_DIR" && pnpm exec prisma db push)
fi

exec "$@"

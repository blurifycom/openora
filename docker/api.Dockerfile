# OSS Casino API image.
#
# Builds the casino-oss workspace and runs apps/api. Build context MUST be the
# casino-oss repo root so the full workspace is available to pnpm.
#
# Usage:
#   docker build -f docker/api.Dockerfile -t oss-api .
#
# Configurable via build args:
#   NODE_VERSION  - default 22
#   PNPM_VERSION  - default 10.33.4
#   APP_DIR       - apps/api (override for forks that move it)
#   EXTENSIONS_FILE - relative path of the extensions config (default ./extensions.config.ts)

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.33.4

# -----------------------------------------------------------------------------
# Stage 1: install full workspace deps (dev + prod) for the build stage
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# Copy lockfile + workspace manifests first so this layer caches across source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps apps
COPY packages packages
COPY infra infra

# Allow native postinstall scripts that need to run during install (prisma, sharp, etc.)
ENV CI=true
RUN pnpm install --frozen-lockfile --ignore-scripts=false

# -----------------------------------------------------------------------------
# Stage 2: merge prisma, generate client, compile every @oss/* package
# -----------------------------------------------------------------------------
FROM deps AS builder
WORKDIR /app

COPY tools tools
COPY tsconfig.base.json ./
COPY extensions.config.ts ./

# 1. Wipe stale composite tsbuildinfo cache (incremental tsc otherwise lies
#    about emitting files when the dist dir was removed out-of-band).
# 2. Merge module prisma partials into infra/prisma/schema.prisma
# 3. Generate the Prisma client
# 4. Build in dependency order: @oss/api's transitive deps -> all modules -> api.
RUN find packages apps -name 'tsconfig.tsbuildinfo' -delete 2>/dev/null || true \
  && pnpm exec tsx tools/prisma-merge.ts \
  && pnpm -F @oss/infra exec prisma generate \
  && pnpm -F '@oss/api-runtime...' -F '@oss/auth...' -F '@oss/orpc-contract...' build \
  && pnpm -F '@oss/module-*' build \
  && pnpm -F @oss/api build

# Compile extensions.config.ts -> extensions.config.js for the runtime loader.
RUN pnpm exec tsc \
      --module ESNext \
      --moduleResolution Bundler \
      --target ES2022 \
      --outDir . \
      --skipLibCheck \
      extensions.config.ts

# -----------------------------------------------------------------------------
# Stage 3: minimal runtime. We keep dev deps (notably prisma CLI) because the
# entrypoint runs `prisma db push` on boot. For a tighter prod image, switch to
# a pre-baked migrate-and-exit container and prune here.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/infra ./infra
COPY --from=builder /app/extensions.config.js ./extensions.config.js

COPY docker/api-entrypoint.sh /usr/local/bin/api-entrypoint
RUN chmod +x /usr/local/bin/api-entrypoint

EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=10 \
  CMD wget -qO- "http://localhost:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/api-entrypoint"]
CMD ["node", "apps/api/dist/main.js"]

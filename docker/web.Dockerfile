# OSS Backoffice (Next.js) image.
#
# Builds packages/sdks/react-sdk/examples/backoffice as a Next standalone bundle. Build context MUST be the
# casino-oss repo root.

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.33.4

# -----------------------------------------------------------------------------
# Stage 1: full workspace deps
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps apps
COPY packages packages
COPY infra infra

ENV CI=true
RUN pnpm install --frozen-lockfile --ignore-scripts=false

# -----------------------------------------------------------------------------
# Stage 2: build linked @oss/* packages then `next build`
# -----------------------------------------------------------------------------
FROM deps AS builder
WORKDIR /app
COPY tools tools
COPY tsconfig.base.json ./

# Linked workspace packages must be built before next build picks them up.
RUN pnpm -F @oss/ui-provider-contract -F @oss/ui-provider-shadcn \
       -F @oss/design-system -F @oss/react-sdk build

ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT_FILE_TRACING_ROOT=/app
RUN pnpm -F @oss/example-backoffice exec next build

# -----------------------------------------------------------------------------
# Stage 3: minimal runtime
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next.js standalone output bundles its own node_modules at .next/standalone.
COPY --from=builder /app/packages/sdks/react-sdk/examples/backoffice/.next/standalone ./
COPY --from=builder /app/packages/sdks/react-sdk/examples/backoffice/.next/static ./packages/sdks/react-sdk/examples/backoffice/.next/static
COPY --from=builder /app/packages/sdks/react-sdk/examples/backoffice/public ./packages/sdks/react-sdk/examples/backoffice/public

EXPOSE 3000

CMD ["node", "packages/sdks/react-sdk/examples/backoffice/server.js"]

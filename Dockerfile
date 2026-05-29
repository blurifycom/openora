# syntax=docker/dockerfile:1
#
# OPTIONAL reference image for the full OSS stack. The platform is library-first:
# default local dev runs the apps on the host via `pnpm dev`, and docker-compose
# ships only postgres. This file exists so `docker compose --profile full up --build`
# can run the whole reference stack (api + web + backoffice) in containers.
#
# It is NOT part of `pnpm verify` / CI and is not the production deploy path -
# downstream operators containerize their own apps. One multi-target build keeps
# the install + monorepo build in a single shared layer.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
ENV CI=1

# --- install deps + build the whole monorepo once (shared by every app target) ---
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# --- api : Hono + oRPC HTTP API (port 3001) ---
FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["node", "dist/main.js"]

# --- web : Next.js player app (port 3000) ---
FROM base AS web
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "exec", "next", "start", "-H", "0.0.0.0", "-p", "3000"]

# --- backoffice : Vite + TanStack Router admin SPA (port 3002) ---
FROM base AS backoffice
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/backoffice
EXPOSE 3002
CMD ["pnpm", "exec", "vite", "preview", "--port", "3002", "--host", "0.0.0.0"]

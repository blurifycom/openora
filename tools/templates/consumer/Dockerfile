# One image for the API and its migrations. Built and run by compose.prod.yml.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "--filter", "./apps/api", "start"]

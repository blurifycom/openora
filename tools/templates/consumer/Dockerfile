# One image for the API and its migrations. Built and run by compose.prod.yml.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "--filter", "./apps/api", "start"]

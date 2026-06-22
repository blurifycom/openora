{
  "name": "{{name}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "build:oss": "pnpm -C {{ossFromRoot}} build",
    "regen": "pnpm -C {{ossFromRoot}} run regen",
    "typecheck": "turbo run typecheck",
    "lint": "oxlint .",
    "sync:agents": "rulesync generate",
    "prepare": "rulesync generate",
    "db:generate": "pnpm -C {{ossFromRoot}} -F @blurifycom/db generate",
    "db:migrate": "pnpm -C {{ossFromRoot}} -F @blurifycom/db migrate",
    "setup:mcp": "tsx {{ossFromRoot}}/tools/setup-mcp.ts --target .",
    "gen": "turbo gen"
  },
  "devDependencies": {
    "@blurifycom/tsconfig": "link:{{ossFromRoot}}/packages/config/tsconfig",
    "@blurifycom/turbo-generators": "link:{{ossFromRoot}}/packages/config/turbo-generators",
    "@turbo/gen": "2.9.14",
    "@types/node": "25.9.0",
    "oxlint": "1.64.0",
    "rulesync": "8.25.0",
    "tsx": "4.22.2",
    "turbo": "2.9.14",
    "typescript": "6.0.3"
  },
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=10.0.0"
  },
  "packageManager": "pnpm@11.5.2",
  "pnpm": {
    "overrides": {
      "@blurifycom/api-runtime": "link:{{ossFromRoot}}/packages/platform/api-runtime",
      "@blurifycom/auth": "link:{{ossFromRoot}}/packages/platform/auth",
      "@blurifycom/core": "link:{{ossFromRoot}}/packages/platform/core",
      "@blurifycom/db": "link:{{ossFromRoot}}/packages/platform/db",
      "@blurifycom/plugin-host": "link:{{ossFromRoot}}/packages/platform/plugin-host",
      "@blurifycom/orpc-contract": "link:{{ossFromRoot}}/packages/contracts/orpc-contract",
      "@blurifycom/shared-schemas": "link:{{ossFromRoot}}/packages/contracts/shared-schemas",
      "@blurifycom/adapters": "link:{{ossFromRoot}}/packages/contracts/adapters",
      "@blurifycom/modules": "link:{{ossFromRoot}}/packages/modules",
      "@blurifycom/react": "link:{{ossFromRoot}}/packages/sdks/react",
      "@blurifycom/tsconfig": "link:{{ossFromRoot}}/packages/config/tsconfig",
      "@blurifycom/turbo-generators": "link:{{ossFromRoot}}/packages/config/turbo-generators"
    }
  }
}

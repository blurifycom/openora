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
    "db:generate": "pnpm -C {{ossFromRoot}} -F @oss/db generate",
    "db:migrate": "pnpm -C {{ossFromRoot}} -F @oss/db migrate",
    "setup:mcp": "tsx {{ossFromRoot}}/tools/setup-mcp.ts --target .",
    "gen": "turbo gen"
  },
  "devDependencies": {
    "@oss/tsconfig": "link:{{ossFromRoot}}/packages/config/tsconfig",
    "@oss/turbo-generators": "link:{{ossFromRoot}}/packages/config/turbo-generators",
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
      "@oss/api-runtime": "link:{{ossFromRoot}}/packages/platform/api-runtime",
      "@oss/auth": "link:{{ossFromRoot}}/packages/platform/auth",
      "@oss/core": "link:{{ossFromRoot}}/packages/platform/core",
      "@oss/db": "link:{{ossFromRoot}}/packages/platform/db",
      "@oss/plugin-host": "link:{{ossFromRoot}}/packages/platform/plugin-host",
      "@oss/orpc-contract": "link:{{ossFromRoot}}/packages/contracts/orpc-contract",
      "@oss/shared-schemas": "link:{{ossFromRoot}}/packages/contracts/shared-schemas",
      "@oss/adapters": "link:{{ossFromRoot}}/packages/contracts/adapters",
      "@oss/modules": "link:{{ossFromRoot}}/packages/modules",
      "@oss/react-hooks": "link:{{ossFromRoot}}/packages/sdks/react-hooks",
      "@oss/tsconfig": "link:{{ossFromRoot}}/packages/config/tsconfig",
      "@oss/turbo-generators": "link:{{ossFromRoot}}/packages/config/turbo-generators"
    }
  }
}

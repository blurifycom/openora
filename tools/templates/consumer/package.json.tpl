{
  "name": "{{name}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "build:oss": "pnpm -C {{ossFromRoot}} build",
    "typecheck": "turbo run typecheck",
    "lint": "oxlint .",
    "db:generate": "pnpm -C {{ossFromRoot}} -F @oss/db generate",
    "db:migrate": "pnpm -C {{ossFromRoot}} -F @oss/db migrate",
    "gen": "turbo gen"
  },
  "devDependencies": {
    "@oss/tsconfig": "link:{{ossFromRoot}}/packages/config/tsconfig",
    "@turbo/gen": "2.9.14",
    "@types/node": "25.9.0",
    "oxlint": "^1.64.0",
    "tsx": "4.22.2",
    "turbo": "2.9.14",
    "typescript": "6.0.3"
  },
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=10.0.0"
  },
  "packageManager": "pnpm@11.1.3",
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
      "@oss/react-sdk": "link:{{ossFromRoot}}/packages/sdks/react-sdk",
      "@oss/ui-provider-contract": "link:{{ossFromRoot}}/packages/ui/provider-contract",
      "@oss/ui-provider-shadcn": "link:{{ossFromRoot}}/packages/ui/provider-shadcn",
      "@oss/tsconfig": "link:{{ossFromRoot}}/packages/config/tsconfig"
    }
  }
}

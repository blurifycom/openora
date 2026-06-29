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
    "db:migrate": "pnpm -F @{{name}}/api db:migrate",
    "db:seed": "pnpm -F @{{name}}/api db:seed",
    "setup:mcp": "tsx {{ossFromRoot}}/tools/setup-mcp.ts --target .",
    "gen": "turbo gen"
  },
  "devDependencies": {
    "@blurifycom/mcp": "link:{{ossFromRoot}}/packages/mcp",
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
  "packageManager": "pnpm@11.5.2"
}

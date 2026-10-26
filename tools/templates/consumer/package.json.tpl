{
  "name": "{{name}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "check:types": "turbo run check:types",
    "check:lint": "oxlint .",
    "test:unit": "turbo run test:unit",
    "verify": "turbo run check:types check:lint test:unit && node .rulesync/hooks/guard-mr.mjs --stamp",
    "gen:agents": "rulesync generate",
    "sync:agents": "node tools/sync-agents.mjs",
    "oss:worktree": "node tools/oss-worktree.mjs",
    "review:precheck": "node tools/review-precheck.mjs",
    "prepare": "node tools/sync-agents.mjs && rulesync generate",
    "db:migrate": "pnpm -F @{{name}}/api exec openora-migrate",
    "db:seed": "pnpm -F @{{name}}/api db:seed",
    "gen": "turbo gen"
  },
  "devDependencies": {
    "@openora/create": "{{coreVersion}}",
    "@openora/mcp": "latest",
    "@turbo/gen": "{{turboVersion}}",
    "@types/node": "{{typesNodeVersion}}",
    "oxlint": "{{oxlintVersion}}",
    "rulesync": "{{rulesyncVersion}}",
    "tsx": "{{tsxVersion}}",
    "turbo": "{{turboVersion}}",
    "typescript": "{{typescriptVersion}}"
  },
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=10.0.0"
  },
  "packageManager": "{{packageManager}}"
}

---
targets:
  - '*'
description: Diagnose the local dev environment - linked {{ossDir}}, node, postgres, ports, caches. Read-only; reports findings + the fix command for each.
---

Run these checks and report a pass/fail line per item with the fix command for failures. Read-only - never apply fixes without being asked.

1. **Node version**: `node -v` matches the major in `.nvmrc` (read the file, don't assume a number). Fix: `nvm use`.
2. **OSS checkout linked** (only in repos that link a local platform checkout - a stock scaffold installs `@openora/*` from npm and skips this and the next check): `{{ossDir}}` exists and `node --input-type=module -e "import {createRequire} from 'node:module'; console.log(createRequire(process.cwd()+'/').resolve('@openora/core/react'))"` resolves. Fix: clone the OSS repo side by side at `{{ossDir}}`, run the repo's link script if it ships one (`pnpm link:oss`), then `pnpm install`.
3. **OSS built**: the resolved path above points into a `dist/` that exists and is newer than `{{ossDir}}/packages/*/src`. Fix: rebuild the linked checkout with the repo's build script if it ships one (`pnpm build:oss`), otherwise build it from `{{ossDir}}`.
4. **Database**: postgres reachable on :5432 (`nc -z localhost 5432`). Fix: `dev:infra` MCP tool (server `oss`) or the compose stack.
5. **Services**: port 3001 (api), plus 3000 (web) and 3002 (backoffice) in repos that have those apps - report which are up. Fix: `pnpm dev`.
6. **Stale bundler cache**: if this repo has a Next app and a build error persists after a fix, `rm -rf apps/*/.next` and rebuild (Turbopack caches across the link boundary).
7. **Generated agent files**: `pnpm gen:agents` runs clean (regenerates from `.rulesync/`).

If everything passes but a build still fails, hand off to the `debugger` agent with the verbatim error - it owns the deeper resolution table (turbopack.root, symlinked tsconfig, externalDir).

---
targets:
  - '*'
description: Diagnose the local dev environment - linked ../oss, node, postgres, ports, caches. Read-only; reports findings + the fix command for each.
---

Run these checks and report a pass/fail line per item with the fix command for failures. Read-only - never apply fixes without being asked.

1. **Node version**: `node -v` matches `.nvmrc` (26). Fix: `nvm use`.
2. **Core resolves**: `node --input-type=module -e "import {createRequire} from 'node:module'; console.log(createRequire(process.cwd()+'/').resolve('@openora/core/react'))"` prints a path. Fix: `pnpm install`.
3. **Database**: postgres reachable on :5432 (`nc -z localhost 5432`). Fix: `dev:infra` MCP tool (server `oss`) or the compose stack.
4. **Services**: ports 3001 (api), 3000 (web), 3002 (backoffice) - report which are up. Fix: `pnpm dev`.
5. **Stale bundler cache**: if a build error persists after a fix, `rm -rf apps/*/.next` and rebuild (Turbopack caches across the link boundary).
6. **Generated agent files**: `pnpm gen:agents` runs clean (regenerates from `.rulesync/`).

If everything passes but a build still fails, hand off to the `debugger` agent with the verbatim error - it owns the deeper resolution table (turbopack.root, symlinked tsconfig, externalDir).

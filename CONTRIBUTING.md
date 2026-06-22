# Contributing

Thanks for jumping in. This guide gets you productive fast. The deep brief lives in
[AGENTS.md](./AGENTS.md) - read it before your first change; it is the canonical
source for architecture, naming, boundaries, and the "where does X go?" decision tree.

## Prerequisites

| Tool   | Version                     |
| ------ | --------------------------- |
| Node   | 26+                         |
| pnpm   | 11+ (via `corepack enable`) |
| Docker | for Postgres (+ Redis)      |

## First run

```bash
pnpm install
pnpm setup:agent   # boots Docker (Postgres + Redis), runs migrations, prints a summary
pnpm seed          # demo data: admin + players + wallets + transactions + games
pnpm dev           # api :3001, mcp dev server
```

Backoffice login: `admin@oss.dev` / `password123` (see `pnpm seed --help` for flags).

## Day-to-day commands

| Command                 | What it does                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`              | turbo dev across api, mcp                                                                                                 |
| `pnpm regen`            | drizzle-kit generate + openapi emit + sdk regen + catalog                                                                 |
| `pnpm verify`           | typecheck + lint (incl. boundaries + module shape) + unit tests                                                           |
| `pnpm test:integration` | service/router tests against real Postgres                                                                                |
| `pnpm sync:agents`      | regenerate the per-tool agent files (AGENTS.md / CLAUDE.md / .codex/config.toml / Copilot) from `.rulesync/` via rulesync |

## Scaffolding (don't hand-roll)

```bash
pnpm gen module <group> <name>   # group: player | backoffice | platform
pnpm gen plugin <name>           # overlay extension under apps/api/src/extensions/
pnpm gen route <module> <method> <path>
pnpm gen ui-component <Name>
```

Each scaffolded file marks editable regions with `// AGENT: implement here` - fill those,
leave the wiring alone. After scaffolding a module/table: `pnpm regen && pnpm verify`.

## Branch model

| Branch                       | Purpose                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `main`                       | Source of truth. Always green. Protected - changes land via MR.             |
| `stage`                      | Pre-prod / release-candidate. Promote from `main`.                          |
| `dev`                        | Shared integration branch for in-flight work.                               |
| `feat/*`, `fix/*`, `chore/*` | Short-lived topic branches. Branch off `main`, open an MR back into `main`. |

Flow: `feat/*` -> MR -> `main` -> promote to `stage` -> promote to release.
CI (`.gitlab-ci.yml`) runs `verify` -> `integration`
on every MR and on pushes to `main`, `stage`, and `dev`.

## Before you open an MR

```bash
pnpm verify
```

Must pass. CI additionally runs a "no drift" check: it re-runs drizzle-kit + the catalog
generator and fails on an uncommitted diff. So if you touched schemas or routes, run
`pnpm regen` and commit the generated output.

## House rules (the short version - full list in AGENTS.md)

- Zod-first. Every shape is a schema; types are `z.infer`'d, never hand-written.
- No `any` outside `*.test.ts`. No inline `fetch`/`axios`. No decorators.
- Cross-module talk goes through events or contracts - never import another module's internals.
- New functionality enters only via `definePlugin`. No auto-discovery, no magic.
- ASCII only in code. Short dashes (-) only.
- Don't hand-edit generated files: drizzle migrations, `docs/openapi.json`, `docs/catalog.json`,
  and the rulesync-generated agent files (`AGENTS.md`, `CLAUDE.md`, `.codex/config.toml`,
  `.github/copilot-instructions.md`, and the `.claude/`, `.github/` mirrors) - edit
  `.rulesync/` and run `pnpm sync:agents`.

## License and contributions

This project is dual-licensed: **AGPL-3.0-only** ([LICENSE](./LICENSE)) or a
commercial license from [Licensor] ([LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md)).

For the dual-license model to work, contributions must be available under both.
By submitting a contribution (a commit, patch, or MR), you:

- License your contribution to the project and its users under the AGPL-3.0-only
  (inbound = outbound), and
- Grant [Licensor] a perpetual, worldwide, non-exclusive, royalty-free right to use,
  relicense, and sublicense your contribution - including under the commercial
  license above - so it can be offered to commercial licensees.

You confirm you have the right to grant this (the work is yours, or you have
permission), per the [Developer Certificate of Origin](https://developercertificate.org/).
Sign off your commits with `git commit -s` (adds a `Signed-off-by` line).

You retain copyright in your contribution. If you cannot grant the commercial
relicensing right above, say so in your MR so we can discuss before merging.

## Working with AI agents

Every module ships an `AGENTS.md`. The `oss-dev` MCP server (stdio, see `.mcp.json`) exposes
the schema registry, route catalog, plugin manifest, and scaffolders as tools. Start at
[docs/agent-quickstart.md](./docs/agent-quickstart.md).

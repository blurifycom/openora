# {{name}}

An igaming platform built on the open-source `@openora/*` packages. This repo holds only
what is unique to your operation - branding, vendor adapters, and overlay plugins. The
core (auth, wallet, gaming, lobby, compliance, backoffice, CMS) is consumed as linked
packages and never forked.

This is a headless api consumer. Build your frontend (player web + admin backoffice)
in its own repo and talk to this api over HTTP via `@openora/react`.

## Layout

```
apps/
  api/          # Hono + oRPC API (:3001) - thin createApp entry + your extensions.config.ts
.rulesync/      # source of truth for agent rules, subagents, commands, skills
.claude/agents/ # generated AI agents
turbo/generators/ # turbo gen: plugin, adapter
```

## Prerequisites

The `@openora/*` packages install straight from npm - no sibling checkout needed. The generated
`devDependencies`/`dependencies` track the `latest` stable tag, so a fresh install always pulls the
newest release; pin an exact version if you need reproducible installs.

## Dev setup

Needs Node.js 22+ and Docker Desktop running.

```bash
pnpm install               # pulls @openora/* from npm
pnpm bootstrap             # .env, Postgres + Redis, schema, admin + demo data
pnpm dev                   # api :3001, docs at http://localhost:3001/docs
```

`pnpm bootstrap` is safe to re-run. It logs the backoffice admin it created (`ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `.env`). For a database that is not local, set `DATABASE_URL` in `.env` and run
`pnpm db:migrate` yourself; `pnpm db:seed` only seeds a local database.

The `oss` MCP server is declared in `.mcp.json`. Approve it in your editor, restart, then run
**`/start`** in Claude Code - it asks what you want to build and scaffolds it for you.

To pull the newest platform release, re-run `pnpm install` (the pin tracks the `latest` stable tag).

The API sends anonymous usage telemetry (a random instance id, the version, the Node.js runtime and
two active-player counts). Set `OPENORA_TELEMETRY_DISABLED=1` in `.env` to turn it off; every field
is listed at https://openora.ai/documentation/telemetry.

## Extending

| Need | Command |
|---|---|
| Overlay plugin (new behavior/routes) | `pnpm gen plugin` |
| Swap a vendor adapter (KYC / payment / notification) | `pnpm gen adapter` |

Register new plugins in `apps/api/src/extensions.config.ts`. Adapters that override a
default binding must be listed AFTER the module that owns the default (last registration of
a DI token wins).

## AI agents

`.claude/agents/` ships agents scoped to this repo, generated from `.rulesync/subagents/`:

- `planner` - plan a ticket: the blocking questions, or a plan with risk-driven test cases
- `builder` - configure extensions, swap adapters, write overlays, customize UI
- `expert` - turn product asks into requirements + acceptance criteria
- `tester` - attack a built change against the running stack, return a verdict table, add the tests, triage bugs; once tests and review pass, record a video per AC on the final commit
- `debugger`, `deployer`, `quality-reviewer`, `security-reviewer`, `compliance-reviewer` - root-cause, packaging, review

The `oss` MCP server (`.mcp.json`) gives them read-only inspection of the platform surface.

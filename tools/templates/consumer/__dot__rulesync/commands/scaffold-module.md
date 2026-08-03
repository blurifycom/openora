---
description: 'Generate a self-contained local add-on package (schema, service, router, plugin.ts, AGENTS.md) and register it. Args: <name>. Consumers rarely need this - prefer an overlay plugin.'
---

> A consumer extends the platform with **overlay plugins** (`scaffold-plugin`) almost always. Reach
> for a local module only when the feature is a genuinely self-contained domain with its own tables,
> service, and routes that you'd otherwise duplicate across plugins.

Run `pnpm gen module $ARGUMENTS` in the repo root. Arg is `<name>` (e.g. `loyalty`). The scaffold
ships a buildable add-on - a `list` route wired contract -> router -> service over a sample table -
so `/check` is green immediately. Then:

1. `<name>/src/schema/index.ts` - Drizzle tables (`pgTable`, snake_case, `timestamp({ withTimezone:
true })` per `docs/standards/database.md`).
2. `<name>/src/schemas/index.ts` - Zod input/output schemas; types via `z.infer`.
3. `<name>/src/service/<name>.service.ts` - business logic; inject `DRIZZLE` + `EVENT_BUS`, no inline
   fetch/SQL.
4. `<name>/src/router/index.ts` - oRPC routes (admin routes `adminGuard.assert` first).
5. Register in `apps/api/src/extensions.config.ts`; `pnpm db:migrate`; `/check`.

Audit every state-changing action. Fill the `// AGENT: implement here` regions; leave wiring alone.

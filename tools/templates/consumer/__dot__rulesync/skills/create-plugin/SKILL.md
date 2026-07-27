---
name: create-plugin

description: >
  Guided creation of an extension - the right way to add behavior or swap a vendor without
  touching `@openora/*` core. Interviews for intent, classifies the seam (plugin / adapter /
  page / route), runs the matching scaffold command, wires extensions.config.ts, and enforces
  boundaries + audit + db rules. Use on "create plugin", "add an extension", "swap KYC/PSP",
  "mount a page", "/create-plugin <name>".
---

# create-plugin

The platform is extended from the **outside only** (overlay plugin / adapter rebind / UI page /
config) - never by editing `@openora/*`. This skill picks the correct seam and scaffolds it.
Domain questions go to `expert` first; review the result with `review`.

## 1. Classify the seam (ask if unclear)

| You want to...                              | Seam    | Command                                    |
| ------------------------------------------- | ------- | ------------------------------------------ |
| Add new routes / event handlers / a service | plugin  | `/scaffold-plugin <name>`                  |
| Replace a vendor (KYC, PSP, notifications)  | adapter | `/scaffold-plugin` -> `pnpm gen adapter`   |
| Mount a react-sdk page on a route           | page    | `pnpm gen page <route>`                    |
| Add one route to an existing add-on/overlay | route   | `/scaffold-route <add-on> <METHOD> <path>` |

If the behavior genuinely cannot be expressed from the outside, STOP - it's an OSS-core change.
Hand off via the `add-feature` skill's `handoff.md`. Do not patch the linked OSS checkout.

## 2. Ground first

- Read `.claude/rules/overview.md` (what you may and may not touch) and
  `.claude/rules/db-conventions.md` (if the extension owns tables).
- Inspect what already exists with the `oss` MCP: `catalog-overview`, `list-adapters` (token +
  default binding to swap), `list-routes` (collision check), `list-slots`, `list-events`.
- For a domain rule you can't safely assume (a limit, a KYC threshold, a jurisdiction behavior),
  spawn `expert` before scaffolding.

## 3. Scaffold + wire

Run the command from step 1, then fill the `// AGENT: implement here` regions. Register the plugin
in `apps/api/src/extensions.config.ts`. **Order matters for adapters** - last registration of a DI
token wins, so list a swap AFTER the module that owns the default binding.

```ts
// good - swap binds after the owning module, so it replaces the default
plugins: [walletModule, myCustomPspAdapter];

// bad - swap before the owner; the default re-binds and your adapter never runs
plugins: [myCustomPspAdapter, walletModule];
```

## 4. Non-negotiables

- **Boundaries**: import only package entrypoints (`@openora/core`, not `.../src` or `.../dist`).
  No imports between extensions; cross-extension data goes through the oRPC client or a schema subpath.
- **Tables**: live in the overlay's own `src/schema/index.ts`; follow `db-conventions` (snake_case,
  `timestamp({ withTimezone: true })`). Run `pnpm db:migrate` after.
- **Audit every mutation**: each state-changing action emits a domain event the `audit` add-on
  subscribes to, or resolves `AUDIT_WRITER` and calls `record(...)`. A mutation with no audit is not done.
- **Validate at the edge**: Zod schemas for every route input/output; no inline `fetch`/SQL in handlers.

## 5. Verify

- `/check` (typecheck + lint) green.
- Plugin boots (API health check / `pnpm dev`).
- Hand to `review` before opening an MR.

## Rules

- Extend from the outside; never edit `@openora/*` or `node_modules`.
- One extension = one concern. Don't commit or push (that's `create-pr`).

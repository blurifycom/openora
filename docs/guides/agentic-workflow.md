# Agentic Workflow

Copy-paste recipes: what to type, in what order, for each common job. Each step says what you type and what happens; your only manual work is answering the questions an agent can't settle. `docs/guides/agent-quickstart.md` is the manual per-module walkthrough if you want to drive every step yourself.

One-time setup (once per clone): run `pnpm run setup`, which starts Docker, migrates the database, wires the MCP server, and installs dependencies.

First time on the platform? Let it onboard you - it interviews you for requirements, then delegates the build to the right agents. Run `/start`, optionally followed by a description such as a tournaments feature.

## Implement a feature (end to end)

Run `/ship` with a ticket id, a work-order path, or just a description of the feature.

It runs on its own and stops only for a question or a blocker:

1. `planner` reads the input and the code it touches and returns a plan with test cases, or the questions only you can answer. Answer them and run `/ship` again.
2. `builder` (or `module-author` / `plugin-author`) builds it in its own worktree, `tester` drives and attacks it, then the reviewers the precheck's roster names review it. Failures go back to the builder, up to three rounds.
3. It pushes the branch and opens the PR. Run `/ship` with the same ticket id again later and it fixes red CI or answers new review comments.

Want to approve the plan and the push yourself? Add the `--ask` flag to `/ship`.

Fuzzy idea instead of a ticket? Start with the domain expert, then feed its output to step 1: ask the `expert` agent to turn your idea into requirements with acceptance criteria, then pass the resulting spec to `/ship`.

## Review code

Everyday review of your branch (cheap, works on capped plans). `/review` with no argument reviews the current branch against `dev`. Variations:

- `/review` followed by a PR number reviews that GitHub PR.
- The `--base` flag picks a different base branch, for example `stage`.
- The `--agents` flag forces the fan-out width.
- The `--fix` flag also applies BLOCK and WARN fixes in the working tree.
- The `--ci` flag runs non-interactively and exits 1 on NO-GO.

## Add a module / route / plugin by hand

When you want to drive implementation yourself instead of `/ship`:

- `/scaffold-module` with a module name creates a new domain module, registered, with a working list route.
- `/scaffold-route` with a module name, an HTTP method, and a path adds a route stub to it.
- `/scaffold-plugin` with a name creates an overlay extension under `extensions/`.

Fill in the regions the scaffold marks with an `AGENT: implement here` comment (or tell the agent to), then after any schema or contract edit:

- `/regen` regenerates migrations and the catalog.
- `/verify` runs typecheck, lint, and unit tests, the same as CI.
- `/verify` with the `--filter` flag set to `@openora/core` scopes it to one package (faster).

`/verify` doesn't just run the checks - it fixes what fails (or explains why a test needs updating) and never reports done on red.

## Ship it

- `/pre-pr` runs the full local gate, including the drift check CI runs.
- `/create-pr` commits, pushes (asks first), and opens the PR.

## Record an architecture decision

Run `/adr` followed by the decision in a sentence, for example splitting the wallet into its own service.

## Ask before you build

Read-only inspection via the `oss-dev` MCP tools - any agent can answer these directly:

- What modules exist? The `list-modules` tool.
- Does a route for a feature already exist? The `list-routes` tool.
- What does a module's schema look like? The `get-drizzle-schema` tool, scoped with its `module` argument.
- Would a new table name collide? The `propose-table-change` tool.

## Change the agents themselves

1. Edit the source under `.rulesync/` (`rules/`, `subagents/`, `skills/`) - never the generated mirrors (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.github/`).
2. `pnpm gen:agents`
3. New/changed subagents load in a fresh session, not the current one.

## Ground rules (hold everywhere)

- Agents are read-only until you approve a plan; they never commit unless asked and never push without a per-action "yes".
- Every state-changing action must leave an audit entry - "no audit entry = not done".
- `pnpm verify` green before any PR; CI also rejects generated-artifact drift (`/pre-pr` catches it locally).

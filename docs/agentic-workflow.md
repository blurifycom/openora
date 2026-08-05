# Agentic Workflow

Copy-paste recipes: what to type, in what order, for each common job. Each step says what you type and what happens; your only manual work is answering questions and approving gates. `docs/agent-quickstart.md` is the manual per-module walkthrough if you want to drive every step yourself.

One-time setup (once per clone):

```
pnpm setup      # docker + db + mcp + deps
```

First time on the platform? Let it onboard you - it interviews you for requirements, then delegates the build to the right agents:

```
/start                        # or: /start I want a tournaments feature
```

## Implement a feature (end to end)

```
/add-feature OSS-123          # or a work-order path, or just describe the feature
```

Then follow the flow - it stops for you twice:

1. **Answer the grill questions.** The agent asks about scope edges, module ownership, data-model choices. Pick options or type answers.
2. **Approve the plan.** You get the exact surface (packages, tables, contracts, events) + task breakdown. Say "approved" (or correct it first). Nothing is edited before this.
3. Wait - implementation, tests, parallel review (`contract-reviewer` + `security-reviewer` + `quality-reviewer`), and QA e2e run agent-side, with fixes looped in automatically.
4. When it reports green:

```
/create-pr
```

5. Confirm the push when asked (pushes always need your explicit "yes").

Fuzzy idea instead of a ticket? Start with the domain expert, then feed its output to step 1:

```
ask the expert agent: turn "<your idea>" into requirements with acceptance criteria
/add-feature <the resulting spec>
```

## Review code

Everyday review of your branch (cheap, works on capped plans):

```
/review                       # current branch vs dev
/review 123                   # a GitHub PR by number
/review --base stage          # different base branch
```

Output: paste-ready line comments + an AC check + one-sentence GO/NO-GO. Nothing is posted or edited - you paste the comments you agree with.

Deep sweep of a large or risky change set (token-heavy):

```
/oss-review                   # one reviewer per applicable dimension
/oss-review --agents 6        # force the fan-out width
/oss-review --fix             # also apply the fixes in the working tree
```

## Add a module / route / plugin by hand

When you want to drive implementation yourself instead of `/add-feature`:

```
/scaffold-module tournaments              # new domain module, registered + working list route
/scaffold-route tournaments POST /tournaments   # add a route stub to it
/scaffold-plugin my-overlay               # overlay extension under extensions/
```

Fill in the `// AGENT: implement here` regions (or tell the agent to), then after any schema/contract edit:

```
/regen                        # migrations + catalog
/verify                       # typecheck + lint + unit tests, same as CI
/verify --filter @openora/core   # scoped to one package (faster)
```

`/verify` doesn't just run the checks - it fixes what fails (or explains why a test needs updating) and never reports done on red.

## Ship it

```
/pre-pr                       # full local gate incl. drift check CI runs
/create-pr                    # commit, push (asks first), open the PR
```

## Record an architecture decision

```
/adr split wallet into its own service
```

## Ask before you build

Read-only inspection via the `oss-dev` MCP tools - any agent can answer these directly:

```
what modules exist?                       # list-modules
does a route for X already exist?         # list-routes
what does the wallet schema look like?    # get-drizzle-schema module=wallet
would table "tournament_entry" collide?   # propose-table-change
```

## Change the agents themselves

1. Edit the source under `.rulesync/` (`rules/`, `subagents/`, `skills/`) - never the generated mirrors (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.github/`).
2. `pnpm gen:agents`
3. New/changed subagents load in a fresh session, not the current one.

## Ground rules (hold everywhere)

- Agents are read-only until you approve a plan; they never commit unless asked and never push without a per-action "yes".
- Every state-changing action must leave an audit entry - "no audit entry = not done".
- `pnpm verify` green before any PR; CI also rejects generated-artifact drift (`/pre-pr` catches it locally).

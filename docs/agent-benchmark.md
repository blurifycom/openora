# Agent token benchmark - before vs after the AI-first hardening

Measures how many tokens an AI agent (acting for a downstream operator) burns to add a
feature, before vs after the hardening pass that fixed doc/code drift, added the generated
`catalog.json`, enforced boundaries, and centralized config.

## Method

- Two fixed tasks, each run by an autonomous agent given the SAME neutral prompt, differing
  only in which repository it read:
  - **BEFORE**: a read-only `git worktree` pinned to the pre-hardening snapshot (tag `benchmark-baseline`).
  - **AFTER**: the hardened working tree.
- Fidelity: **read + design only** - each agent explores and outputs the implementation as
  text (it does not write files or run `verify`). This isolates the dominant, on-thesis cost:
  comprehension + exploration (figuring out what to build and where from the repo itself).
- Tasks: (1) implement a Stripe `PaymentAdapter` as an overlay; (2) add a `tournaments`
  player module end-to-end.

### Important caveats (read before trusting the absolute numbers)

1. **Sub-agents had no access to the `oss-dev` MCP server.** So this measures the
   docs / `catalog.json` / structure / example improvements only - NOT the MCP tool hardening
   (response_format, guiding errors, the new `@oss/mcp`). Real sessions with the MCP server
   would save more.
2. **The baseline tag under-represents the immediate pre-session tree.** It was created with
   `git stash create`, which excludes untracked files; at snapshot time large parts of the
   codebase (`@oss/adapters`, the `wallet` module, the Drizzle layer) were untracked, so the
   baseline reflects an older committed state. The absolute deltas therefore conflate
   "completing the Drizzle migration" with "this session's doc/catalog polish." The
   directional result and the qualitative behavior below are robust regardless.

## Results

| Task                          | BEFORE tokens | BEFORE tool calls | AFTER tokens | AFTER tool calls | Token Δ    | Tool Δ   |
| ----------------------------- | ------------- | ----------------- | ------------ | ---------------- | ---------- | -------- |
| Stripe PaymentAdapter overlay | 54,561        | 29                | 46,485       | 17               | -14.8%     | -41%     |
| `tournaments` module          | 73,659        | 37                | 45,090       | 20               | -38.8%     | -46%     |
| **Total**                     | **128,220**   | **66**            | **91,575**   | **37**           | **-28.6%** | **-44%** |

## The qualitative finding (the real point)

Tokens are secondary to _correctness_. On the unpolished repo the agents repeatedly hit the
doc/code-drift trap this effort set out to eliminate:

- **BEFORE / module task** concluded, verbatim: _"the prose docs describe Drizzle + a single
  `@oss/modules` package, but the actual buildable code uses Prisma + per-module packages...
  I followed the real code."_ It then produced a **Prisma-based** module with per-package
  `package.json` - the wrong target end-state - and even flagged that `@oss/db` exports a
  "stale DrizzleService." The drift didn't just cost tokens; it steered the agent to the
  wrong answer.
- **BEFORE / adapter task** concluded the payment seam was a no-op with "docs out of sync,"
  spending 29 tool calls confirming `@oss/adapters` and the `wallet` module were absent.
- **AFTER / both tasks** found `AGENTS.md` -> the decision tree, `catalog.json` (adapter seam
  table showing payment **wired**, module list, config schema), and the existing modules, and
  produced **correct, confident** implementations (Drizzle, single package, real token/seam)
  with fewer tool calls and no "docs contradict code" reconciliation.

## Takeaway

The hardening reduced exploration tokens ~29% and tool calls ~44% on these tasks, but the
decisive win is that the agent stops fighting a lying source of truth: after the pass, the
docs match the code and the generated catalog gives a single deterministic place to learn
"what can I extend," so the agent reaches the right answer instead of a plausible-but-wrong
one. Re-run with `pnpm regen` current and the `oss-dev` / `@oss/mcp` servers connected to
capture the MCP-tool savings this read-only harness could not measure.

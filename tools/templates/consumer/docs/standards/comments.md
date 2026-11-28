# Comments

Zero comments. The code is the only source of truth: a comment is a second copy that no test covers, it goes stale without failing anything, and it lets a known problem live on next to the code that has it.

The `openora-comments/no-comments` lint rule, which arrives through the extended `@openora/core/oxlint/oxlintrc.json`, warns on every comment it does not recognise as a directive. It is a warning while the existing comments are removed; it does not fail `pnpm verify`.

## Rules

- **No comments of any kind.** Inline, block, JSDoc, `TODO`, `FIXME`, `mock:`, section dividers, commented-out code. The same holds in tests, config, CI, infra, SQL and CSS.
- **Meaning goes into the code.** A block that needs explaining gets a better name, an extracted function, a named constant, a narrower type, or a schema. A test name states the behaviour; its assertions are the evidence.
- **An invariant or an external constraint is pinned by a test, not described.** A vendor's quirk, a regulatory limit, an ordering that must hold: write the test that fails when someone breaks it.
- **A reason is not code.** Why this approach, why this order, what changed and why: the commit message, the PR description, or an ADR in `docs/adr/`.
- **No nuances left behind.** A comment explaining a workaround means the problem is still there. Fix the cause where it lives, in the same change: the shared function every caller goes through, the owning module, or the platform core. Never a guard at one call site, a retry, a sleep, a cast, a flag, or a catch that hides it. When the cause cannot be fixed in this change, stop and ask; out-of-scope work becomes a ticket, never a marker in the code.
- **Placeholder data is named, not annotated.** It lives in a file, folder or constant whose name says it is a mock.
- **Touching a file removes its comments.** Delete every comment in the lines you change. A comment your change made wrong is deleted, never reworded.

## The only exceptions

Machine-read directives a tool needs to run, nothing a human is meant to read:

- a lint suppression for one named rule (`oxlint-disable-next-line`), and only where the rule cannot be satisfied by fixing the code
- `@ts-expect-error` in a test that asserts a type error
- a shebang, `@vitest-environment`, `/// <reference types>`, `@__PURE__`
- a JSDoc that is only `@alias`, or only `@deprecated Use` and the replacement's name: knip, the editor and the `no-deprecated` lint read them
- a Dockerfile `# syntax=` line and a schema directive such as `# yaml-language-server`

A directive carries no prose after it.

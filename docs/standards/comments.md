# Comments and documentation

Detail for the "zero comments" line in `conventions`. Read this before writing any comment or JSDoc block.

- **Zero comments. A comment is an exception you must justify, not a nicety.** Assume the answer is "no comment" and let the code carry the meaning.
- **The only thing that earns one: a fact the code CANNOT contain** - an external system's behaviour, a third-party bug, a spec/regulatory constraint. The test is whether a careful reader would otherwise "fix" the code and break it. `// Stripe rounds half-to-even; mirror it so our totals reconcile.`
- **A reason is not a fact - it does not earn a comment.** Why this order, why 2 retries and not 4, why not the obvious approach, what a block does, what changed: all of that goes in the commit message, the PR description, or an ADR. Those are versioned and reviewed; an inline rationale is neither, and it rots in place. Naming the thing well (`PLAYER_FACING_TIMEOUT_MS`) beats a paragraph above it.
- **If a block needs a comment to be understood, rename or extract first** - a comment is the fallback after that fails, never the first move. Writing one is the signal that the naming or the decomposition is wrong.
- **Never in tests.** A test name states the behaviour and the assertions state the evidence. Seeded values, fixture choices and timing tricks get named constants or helpers, not narration.
- **Same bar in config, CI and infra files** (`turbo.json`, workflow YAML, compose). Step names and keys are self-describing; step ordering and tuning rationale belong in the commit that introduced them.
- **Never** restate a name (`// increment the counter`), narrate steps (`// step 2`), announce edits (`// added for X`), or divide sections (`// ---`, `// ===`).
- **JSDoc on every exported function/class >~15 lines or with non-obvious params.** Multiline `/** ... */` block (opening and closing on their own lines). Document the surprising contract, not the name.
- **`// TODO:` for deferred work, `// FIXME:` for known-broken code** - greppable, with context and an issue key where one exists. Never bare.

  ```ts
  // TODO: replace polling with the webhook once BE ships it (ABC-312)
  // FIXME: race - two admins approving the same withdrawal double-credit the player
  ```

- **`// mock:` marks placeholder data / stubbed behavior** so throwaway code stays findable. `// mock: fixed rate until the FX adapter lands`

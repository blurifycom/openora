# Documentation

A prose doc states the business rule, the flow, and the decision. It does not restate the code.

## What owns what

| Question                                                           | Answer lives in                  |
| ------------------------------------------------------------------ | -------------------------------- |
| What is the exact route, table, column, event, enum, or port name? | `docs/catalog.json` and the code |
| What is a function's signature?                                    | the contract or schema file      |
| What must be true for the money to be right?                       | `docs/standards/`                |
| Why does the system work this way?                                 | `docs/adr/`                      |
| What does this module own, and what breaks it?                     | `docs/modules/`                  |
| What does a vendor have to provide, and how do the pieces move?    | `docs/adapters/`                 |

The catalog is generated on every `pnpm regen`, so it is never stale. A name copied into prose is
stale the moment someone renames it, and nothing fails when it happens.

## Rules

- **Name the capability, not the symbol.** "the vendor reports its sweepable balances" survives a
  rename; the method name does not. Where a reader needs the exact symbol, link the contract file
  once and let them read it there.
- **No code samples that duplicate a shipped file.** Link the real implementation or the template
  the generator emits. A sample in prose is a second copy that no test covers.
- **No enum values, status strings, permission strings, or column names in prose.** Describe the
  state ("a withdrawal still waiting on the vendor"), not its spelling.
- **No route tables.** The catalog has every route with its permission.
- **No file-path inventories.** A table of "which file owns what" is a map of today's tree, and the
  tree moves. Point at the directory.
- **Describe the target, not only the present.** A doc may describe behaviour the code has not
  reached yet, as long as it says so plainly. The code is then adjusted to the doc, not the other
  way round. Mark anything unbuilt so nobody reads it as a description of what ships.
- **A vendor's own operational rules are business content, not code.** Quorum requirements, fee
  economics, key handling, and rate limits belong in prose, because no generated artifact carries
  them.

## When a doc and the code disagree

Fix the code, or change the doc deliberately and say why. Do not quietly rewrite the doc to match
whatever the code happens to do; that is how a standard turns into a changelog.

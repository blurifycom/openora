# Documentation

A prose doc states the business rule, the flow, and the decision, and points at the code that
implements them. It never contains code.

## What owns what

| Question                                                           | Answer lives in                  |
| ------------------------------------------------------------------ | -------------------------------- |
| What is the exact route, table, column, event, enum, or port name? | `docs/catalog.json` and the code |
| What is a function's signature?                                    | the contract or schema file      |
| What must be true for the money to be right?                       | `docs/standards/`                |
| Why does the system work this way?                                 | `docs/adr/`                      |
| What does this module own, and what breaks it?                     | `docs/modules/`                  |
| What does a vendor have to provide, and how do the pieces move?    | `docs/adapters/`                 |

The catalog is generated on every `pnpm regen`, so it is never stale. A copied value (an enum
spelling, a column, a route, a permission string) is stale the moment someone changes it, and
nothing fails when it happens. A reference is different: a path or a function name used as a
pointer breaks visibly on a rename, and the reader follows it to the source.

## Rules

- **No code in a doc.** No fenced code blocks, no snippets, no example payloads, no config
  excerpts, no copied signatures. A sample in prose is a second copy that no test covers and that
  goes stale without failing anything.
- **Reference the code instead.** Describe the behaviour in prose and point at where it lives: a
  file path, a function or symbol name, a script name, each in backticks, or a link to the file.
  The reader opens the reference; the doc never restates what it contains.
- **No enum values, status strings, permission strings, or column names in prose.** Describe the
  state ("a withdrawal still waiting on the vendor"), not its spelling.
- **No route tables.** The catalog has every route with its permission.
- **No file-path inventories.** A table of "which file owns what" is a map of today's tree, and the
  tree moves. A single pointer where the prose needs it is fine; a listing is not.
- **Describe the target, not only the present.** A doc may describe behaviour the code has not
  reached yet, as long as it says so plainly. The code is then adjusted to the doc, not the other
  way round. Mark anything unbuilt so nobody reads it as a description of what ships.
- **A vendor's own operational rules are business content, not code.** Quorum requirements, fee
  economics, key handling, and rate limits belong in prose, because no generated artifact carries
  them.

## When a code change obliges a doc change

The catalog regenerates itself, so a renamed route or column needs nothing from you. Prose is
different: it only changes when someone changes it, and nothing in `pnpm verify` reads it. Five
changes carry a doc obligation, and the delivery workflow runs `docs` scoped to the branch diff
to discharge it:

| Change                                                          | Update                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| A module gains, loses, or redraws what it owns                  | that module's `docs/modules/` page                        |
| An adapter port changes what a vendor must provide              | that port's `docs/adapters/` page                         |
| A rule about money, KYC, responsible gambling, or audit changes | the owning `docs/standards/` file, before the code merges |
| A config field appears, disappears, or changes meaning          | wherever the surrounding behaviour is described           |
| The code stops matching an "is" claim in an accepted ADR        | a dated Update block on that ADR                          |

An ADR is written, not updated, when a decision changes architecture, a boundary, a seam, or a
convention - `/adr` scaffolds it. An ADR records why a decision was made and is never rewritten
afterwards: supersede it, or prepend a dated Update block. Partial supersession is normal, so an
ADR whose reasoning still holds keeps `Status: Accepted` and carries the Update block instead.

A refactor that moves code without changing what it does obliges nothing.

## When a doc and the code disagree

Fix the code, or change the doc deliberately and say why. Do not quietly rewrite the doc to match
whatever the code happens to do; that is how a standard turns into a changelog.

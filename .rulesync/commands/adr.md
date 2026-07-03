---
targets:
  - '*'
description: 'Scaffold and write an Architecture Decision Record. Arg: short title (eg /adr split wallet into its own service). Use for any decision that changes architecture, boundaries, seams, or conventions.'
---

Run `pnpm gen adr $ARGUMENTS` to scaffold the next-numbered file under `docs/adr/`, then fill it in:

- **Context** - the forces at play, in full sentences. What problem, what constraints, what alternatives were on the table.
- **Decision** - what we chose and why, in active voice. Name the rejected alternatives and the one-line reason each lost.
- **Consequences** - what becomes easier, what becomes harder, what future work this locks in or unlocks.
- **Status**: Proposed until a human accepts it. Never mark Accepted yourself.

Rules:

- One decision per ADR. A second decision is a second ADR.
- Never rewrite an existing ADR's Context/Decision - drift gets a dated `> **Update (YYYY-MM-DD)**: ...` block at the top; a reversal gets a new ADR and the old one becomes `Status: Superseded by ADR-XXXX`.
- Cross-reference related ADRs and the rule docs the decision affects; if a rule doc (`.rulesync/rules/*`) must change as a result, edit it in the same change and run `pnpm sync:agents`.

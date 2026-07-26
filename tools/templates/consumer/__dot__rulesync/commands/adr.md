---
targets:
  - '*'
description: 'Record an architectural decision in docs/adr/. Args: <title>. Numbers sequentially, follows the ADR-0001 format (Context / Decision / Consequences).'
---

Create `docs/adr/NNNN-<kebab-slug>.md` where `NNNN` is the next number after the highest existing one (`ls docs/adr/`).

Structure (match `0001-modular-architecture.md`):

```markdown
# ADR NNNN: <Title>

## Context

<the problem/forces, 2-5 lines - why a decision was needed>

## Decision

<what was decided, imperative and concrete; bullets for the specifics>

## Consequences

<what becomes easier/harder; follow-ups it creates>
```

Rules:

- Fill it from the current conversation/diff - state the decision actually made, not options considered. If the decision isn't settled, say so and ask instead of writing a speculative ADR.
- One ADR = one decision. Reference related ADRs by number.
- If the decision changes agent-facing conventions, also update the matching `.rulesync/rules/*` file and run `pnpm sync:agents`.
- Report the file path when done. Don't commit unless asked.

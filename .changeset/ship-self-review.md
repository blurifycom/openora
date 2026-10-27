---
'@openora/create': minor
---

Consumer `ship` runs the `review` skill as its self-review before the push and opens the MR only on APPROVED, so people reviewing the MR read it by hand instead of running another AI review. Threads from the forge's AI review count like a person's, and `ship` never merges: `docs/agents/forge.md` says who does. The testing standard adds that a deliberately broken money, KYC, responsible-gambling or authz check must fail at least one test.

---
'@openora/create': minor
---

Consumer agent rules, skills and subagents now ship tests in the same pull request as the change or fix, instead of a separate stacked test pull request. `qa` writes the E2E specs after its manual pass, `builder` writes unit tests for pure logic, and the description ends with a "Tests" list of what was added. A changed behaviour with no test is a review `[WARN]`, never a `[BLOCK]`.

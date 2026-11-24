---
'@openora/create': minor
---

Consumer `ship` and `planner` deliver one ticket as one pull request however big it is: a story shipped by its key is one PR for its whole scope, a sub-task one PR for itself. The planner no longer replies `Split:` and `ship` no longer creates `ship-slice` sub-tasks or stacks slice PRs; splitting is a person's call, made with sub-tasks. The `create-pr` description is now a review pack: summary, risks, diagram, API table, DB and config diff, traces, AC and evidence, walkthrough video, local test steps and after-merge steps.

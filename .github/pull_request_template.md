<!--
A review pack: a reviewer approves from it without reading code, and every claim in it is checkable. First line: the bare ticket key, or `Closes #<issue>`. Then one summary line and the generated "Touches:" line. The same 14 slots in every PR, every heading kept, open, in this order; a slot that does not apply says "N/A: <reason>". Size changes nothing. This repo is public: no internal URLs, hosts, operator names or personal data. Plain words and diagrams, no code, paths or symbol names. Mermaid is horizontal (`flowchart LR`, an erDiagram or stateDiagram-v2 with `direction LR`), no theme or `style` lines, what changed filled with the added / changed / removed classes and the legend line under it. No `<details>` folds and no tables outside slot 12. What nobody measured stays visible: "not labelled", "not measured", "not traced". On a money, KYC, responsible-gambling or authz change slots 1 and 3 are never N/A.
-->

## 1. Decisions made

<!-- Per call the issue did not settle: Chose / Instead of / Set by (the person or role who owns it). -->

## 2. Origin

<!-- A fix: "Found:" (report, CI, a consumer), "Lives in:" (module or package), "Cause:", "Reproduced:". Docs, deps, tests or tooling: rename to "## 2. Why", at most three bullets; a temporary CI change ends with "Revert when: <condition>". -->

## 3. How it was checked

<!-- The hostile cases tried, one line. Never "green" or a test count: the checks and the diff show them. "Dropped findings:" each review finding not fixed, with why; security ones as a count only. A money, KYC, responsible-gambling or authz change adds "Not covered:" and "Revert leaves:". -->

## 4. Env

<!-- Per config field or env variable added, changed or removed: name, Lives in, Set in, Default, Copy value from, a bold "Before release:" line. "Set in" and "Copy value from" name a role or a public doc, never a host, URL or vault path. Never a value. -->

## 5. Consumer impact

<!-- Which exports, routes, events or config fields change for a consumer, and whether it is backward compatible. -->

## 6. Related PRs

<!-- A paired change shares this branch name; never name, link or describe the consumer repo or operator. Otherwise the release it ships in. -->

## 7. Flow

<!-- ### Request path: one flowchart LR, caller to response status and total, every middleware and gate in order, every step with its ms, every arrow labelled with what crosses it (from the trace span, else the code, else "not labelled"). ### Event flow: producer, outbox write, "after commit +lag ms", handler, each sink. ### Pipeline for a CI change. -->

🟩 added · 🟨 changed · 🟥 removed

## 8. Data model

<!-- One erDiagram, "direction LR" first: changed tables plus one foreign key away, keys and marked columns only. -->

🟩 added · 🟨 changed · 🟥 removed

## 9. Migration

<!-- Per file: lock (from the SQL), time and rows (a local run on seeded test data only, no ids, emails, amounts or hosts, else "not measured"), "Data loss:" (drop, type change, removed enum value). -->

## 10. Trace

<!-- One #### METHOD /path per changed or added procedure: the gantt from packages/testing/scripts/trace-report.ts; A local run on seeded test data only, no ids, emails, amounts or hosts; "not traced" when missing; a removed one says "removed, nothing to trace". ### Queries and indexes when a query is new. -->

## 11. Performance

<!-- ### Load on a hot path: players reached of 1000, p95, CPU and RAM for api and database before and after, queries per request at 1/10/100 items. ### Measurement for a benchmarked change. All numbers from a local run on seeded test data only, no ids, emails, amounts or hosts. -->

## 12. Evidence

<!-- ### Sample output for a script, CLI or generator. ### Video (table Flow | Before | Now | AC, one row per AC, each clip the whole flow of its AC in one take, from the screen the user starts on to the outcome the AC names, never a few seconds of the end state, the AC cell naming the criterion and its verdict PASS, FAIL or UNCHECKED; test accounts only, a login restored or typed before recording starts) or ### Screenshots before | after side by side for a look-only change. -->

## 13. Business logic

<!-- A decision flowchart LR when a branch has three or more outcomes; ### State machine (stateDiagram-v2, direction LR) when a status is added, removed or moved. -->

🟩 added · 🟨 changed · 🟥 removed

## 14. Endpoints and permissions

<!-- flowchart LR caller to endpoint, guard and role on the edge, response and new status codes in the node; "backward compatible" or "breaking". -->

🟩 added · 🟨 changed · 🟥 removed

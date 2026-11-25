<!--
A review pack: a reviewer approves from it without reading code, and every claim in it is checkable. Plain words and diagrams, no code, paths or symbol names; generated from the diff, the schema diff and real spans, never invented. This repo is public: bare ticket keys only, no internal URLs, hosts, operator names or personal data.
Keep a section only when its trigger fires; delete the rest. "How it was checked" and the three artifacts a reviewer looks at instead of the code ("Request path", "Data model", "Trace") stay open as headings, in that order; every other section stays collapsed, its summary line carrying the gist. Budget: the words that show before anything is expanded fit one screen (about 1500 characters, the open diagrams aside), and each collapsed section fits one screen (about 1500 characters plus its diagram); the detail lives in the diagram or table, not in paragraphs. Mermaid: horizontal, no theme or `style` lines; what the change adds, changes or removes is filled: `classDef added fill:#3fb95033,stroke:#3fb950,stroke-width:2px`, `classDef changed fill:#d2992233,stroke:#d29922,stroke-width:2px`, `classDef removed fill:#f8514933,stroke:#f85149,stroke-width:2px,stroke-dasharray:4`.
First line: the bare ticket key, or `Closes #<issue>`. Sections 7 (e2e steps) and 11 (video) are left out: this repo is headless, so the trace is its walkthrough.
-->

## How it was checked

<!-- Checks result for the head SHA, then each test that proves the change, named by the behaviour it proves. Review findings dropped as not holding, each with why; a dropped security finding as a count only. -->

## Request path

<!-- Trigger: a route, procedure, middleware, service or query on a request path changes. A flowchart LR of the whole path of the main changed request, nothing cut: the caller, every middleware and gate in the order it runs, the handler, each service and port it calls, then the database, cache, queue and adapters it reaches. Take the hops from the procedure's real middleware chain and the spans of its trace, not from memory. Numbered edges say what each hop carries. Every hop the change adds, changes or removes carries the added / changed / removed class. One diagram per changed entry point, at most three, the rest named in a list. -->

## Data model

<!-- Trigger: a route, procedure, service or query on a request path changes, or a migration or schema change. An erDiagram of the tables the changed flow reads and writes plus every table one foreign key away, with their relations, keys and the columns the flow touches. A new, changed or removed table carries the added / changed / removed class (`ledger_entries:::added`), a new or changed column says "new" or "changed" in its comment. No schema change: one line under the diagram saying so. With a migration: locks, backfill, safety under traffic, config fields added or removed, as a list. -->

## Trace

<!-- Trigger: a route, procedure, service or query on a request path changes. The gantt from packages/testing/scripts/trace-report.ts for the happy path, one per acceptance criterion a request proves, and each refusal in its own nested <details>; "trace: none" only when the integration suite exported no spans for it. Spans from a local run on test data only, no ids, emails or amounts from real data. -->

<details><summary><b>1. Architecture diff</b>: </summary>

<!-- Trigger: a new module, package, external call or dependency between modules, or 3+ modules touched. Changed nodes plus one neighbour each side, max ~10 nodes. -->

</details>

<details><summary><b>3. Business logic</b>: </summary>

<!-- Trigger: 3+ new branches or a changed error outcome. Decision flowchart, exact status and reason per caller. -->

</details>

<details><summary><b>4. Endpoints and permissions</b>: </summary>

<!-- Trigger: a route, contract, event payload or status code changes. flowchart LR caller -> endpoint, payload on the edge, response in the node; backward compatible or not. -->

</details>

<details><summary><b>5. Queries and indexes</b>: </summary>

<!-- Trigger: new or changed queries on a request path, or a money path. A sequenceDiagram, one arrow per query with its index, the queries the change adds inside `rect rgba(63, 185, 80, 0.15)`. Then performance conclusions as a list: index per new query, N+1, queries added per request, sequential queries that could run in parallel, repeated reads. -->

</details>

<details><summary><b>8. AC -> evidence</b>: </summary>

<!-- Trigger: the work has acceptance criteria. -->

| AC  | behaviour | test | trace | result @sha |
| --- | --------- | ---- | ----- | ----------- |

</details>

<details><summary><b>9. Decisions to accept</b>: </summary>

<!-- Trigger: a tradeoff the issue did not settle; always on money, KYC, responsible-gambling or authz (then first). Numbered, each with an owner. Alternatives considered go here. -->

</details>

<details><summary><b>10. Test quality and rollout</b>: </summary>

<!-- Trigger: a large or risky change, any money, KYC, responsible-gambling or authz change, or a config change. Mutation and hostile cases, what is not covered, migration order, consumer impact, what a revert leaves behind, docs and ADRs to update. -->

</details>

<details><summary><b>12. Code review guide</b>: </summary>

<!-- Trigger: a large change. Ordered stops: contract -> tables -> server -> writes, each named by what it does. -->

</details>

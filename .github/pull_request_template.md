<!--
A review pack: a reviewer approves from it without reading code, and every claim in it is checkable. Plain words and diagrams, no code, paths or symbol names; generated from the diff, the schema diff and real spans, never invented. This repo is public: bare ticket keys only, no internal URLs, hosts, operator names or personal data.
Keep a section only when its trigger fires; delete the rest. Budget: what shows before anything is expanded fits one screen (about 1500 characters), and each section fits one screen (about 1500 characters plus its diagram); the detail lives in the diagram or table, not in paragraphs. Every section but "How it was checked" stays collapsed, its summary line carrying the gist. Mermaid: horizontal, no fills, a coloured border on what changed (added #3fb950, changed #d29922, removed #f85149 dashed).
First line: the bare ticket key, or `Closes #<issue>`. Sections 2 (infra path), 7 (e2e steps) and 11 (video) are left out: this repo has no deploy infra or player UI.
-->

## How it was checked

<!-- Checks result for the head SHA, then each test that proves the change, named by the behaviour it proves. Review findings dropped as not holding, each with why; a dropped security finding as a count only. -->

<details><summary><b>1. Architecture diff</b>: </summary>

<!-- Trigger: a new module, package, external call or dependency between modules, or 3+ modules touched. Changed nodes plus one neighbour each side, max ~10 nodes. -->

</details>

<details><summary><b>3. Business logic</b>: </summary>

<!-- Trigger: 3+ new branches or a changed error outcome. Decision flowchart, exact status and reason per caller. -->

</details>

<details><summary><b>4. Endpoints and permissions</b>: </summary>

<!-- Trigger: a route, contract, event payload or status code changes. flowchart LR caller -> endpoint, payload on the edge, response in the node; backward compatible or not. -->

</details>

<details><summary><b>5. Queries, indexes, trace</b>: </summary>

<!-- Trigger: new or changed queries on a request path, or a money path. One arrow per query with its index; the gantt from packages/testing/scripts/trace-report.ts when the integration suite exported spans, else "trace: none". Spans from a local run on test data only, no ids, emails or amounts from real data. -->

</details>

<details><summary><b>6. Data</b>: </summary>

<!-- Trigger: a migration or schema change. erDiagram of new or changed tables, then locks, backfill, safety under traffic, config fields added or removed. -->

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

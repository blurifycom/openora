---
name: ship
targets: ['*']
description: >
  Take one {{trackerKey}} ticket from plan to a green, reviewed MR with nobody in the loop: it plans
  it with test cases and builds it itself, tester attacks it, the reviewers review it, then it
  pushes the ticket branch, opens the MR, moves the ticket and watches the MR until it is ready for a
  person to review. Resumable: every run reads the ticket,
  branch, MR and CI and does the next step, including fixing a red pipeline or new review comments.
  Stops only on a question or a blocker. Use on "ship {{trackerKey}}-XXX", "add feature", "deliver
  {{trackerKey}}-XXX", or /ship {{trackerKey}}-XXX [--ask].
---

# ship ({{name}})

The orchestrator: one ticket key in, a green MR in Code Review out. You own the ticket's whole delivery, plan to review: you are done when the MR is ready for a person to review it (step 7), not when it is opened. You run in the main session and are the only one who delegates. You plan and build yourself, so the ticket, the plan, the code and every test result stay in one context; you delegate only what needs fresh eyes - `tester` attacks the change, the review skill's reviewers read the diff, `expert` settles domain questions - read each verdict and pick the next step yourself. Never wait for a person between steps. Every subagent you start is told it starts no subagents of its own; a domain question one of them returns comes back to you, you ask `expert`, and you act on the answer.

## Coordinates

- Jira: per `docs/agents/issue-tracker.md`, project `{{trackerKey}}`. Code forge: `{{gitRemotePath}}`, target `{{mrTarget}}`, commands in `docs/agents/forge.md`.
- `{{ossDir}}` (the linked OSS checkout) is read-only. Core-only work goes through `handoff.md`.

## Arguments

- `{{trackerKey}}-XXX` from `$ARGUMENTS`. None: ask for it, that is the one question this skill always asks.
- `--ask`: stop for approval after the plan and before the push. Without it, invoking `/ship` is the authorization for every write below - and only those.

## What ship may write without asking

- Jira, on this ticket only: the Plan comment (and its test cases where the repo's `test-plan` skill keeps them), a questions comment, a blocker comment, the MR link comment, and the transitions to In Progress and to Code Review. Nothing else: no field edits, no other transitions, no other tickets.
- Git: commits on the ticket branch `<type>/{{trackerKey}}-XXX/<slug>` and pushing it. Never a push to `{{mrTarget}}`, `stage`, `prod` or any shared branch.
- Force-push: only `git push --force-with-lease` on the ticket branch, and only while every commit on the remote branch past `{{mrTarget}}` is your own (`git log --format=%ae origin/{{mrTarget}}..origin/<branch>` shows only your `git config user.email`). Someone else's commit there: merge, never push over it. Never a plain `--force`.
- Merging: into a feature branch only (`{{mrTarget}}` merged into the ticket branch to clear conflicts, a stacked MR into its parent ticket branch). Never into `{{mrTarget}}`, `dev`, `develop`, `stage`, `staging`, `prod`, `production`, `main` or `master`.
- The forge: opening the MR for that branch and replying on its review threads. Every comment you leave starts with `Agent:`, so `watch-pr.mjs` and other tools never take it for one to answer.
- Slack: a one-line draft only, never sent.

## Do what the work needs, inside the worktree

Never stop to ask for something local that deleting the worktree undoes: do it, and say what you did in the reply and the MR description.

- Env: a variable the change needs goes into the worktree's `.env` with a local dev value, and into every place the repo declares one (env schema, `.env.example`, deploy docs) in the same commit. A value only a person has (a real API key, a prod URL): a dev placeholder or a mock locally, and a "Needs before deploy" line in the MR description. If no test can run without the real one, that is a blocker.
- Dependencies: add what the plan needs with the repo's package manager and commit the lockfile. A repo rule that asks for a step first (unlink a locally linked package, then link it back) is followed, so the lockfile carries no local links; it is never a reason to stop.
- Data: the worktree's own database and Redis db - create, migrate, seed and reset them freely. Migrations come from the repo's generator, generated files from its regen command.
- Processes and tools: start what the tests need on the worktree's own ports and stop it before you report; install a local tool the repo's docs name (browsers for Playwright and the like).

## Access outside the repo

The plan's Access list names every account or session outside the repo the work needs (a cloud CLI profile, a provider's dashboard, a sandbox API), each with what it is for, a read-only check that proves the session works and the login a person runs. Before 2, every run runs each check:

- One fails -> `Asked:` on its own line, then each missing login as the command a person runs (`! aws sso login --profile <p>`) or the page to log in to in the browser. Report it, stop; no ticket comment. `/ship {{trackerKey}}-XXX` again picks up from here.
- All pass -> read what it names freely. A passing check is not consent to change anything there, and neither is an Access list built from the ticket. Before the first change outside the repo (create, configure, delete, issue a key): `Asked:`, then one line per change - account, resource, what changes - report it, stop. A person's yes in this session covers that exact list; anything not on it, or a new run, asks again. Then make the changes and put a dev key it issues in the worktree's `.env`.
- Every change outside the repo goes in the reply and the MR description under "Outside the repo", one line each: where, what, how to undo it. A change to something that already existed records its old value.

## Never, however blocked

Anything shared, remote, or not undone by deleting the worktree, unless a person approved that exact change (see Access outside the repo):

- Servers, ssh, cloud accounts, dashboards, deploys, stage and prod, and any database that is not the worktree's own.
- CI/CD settings and variables, repo settings, other people's branches and MRs.
- Anything this run did not create, in the repo or outside it: no drop, flush, kill or delete.
- Secrets: never commit, print or invent a real-looking one; a `.env` with real values stays uncommitted.
- Gates: no `--no-verify`, no skipped or loosened test, lint rule or guard hook, no hand edit to a generated file or `node_modules`.

Blocked by one of these: `Blocked:` with what is needed and who can do it. Every subagent you start gets both lists.

## Read the state, do the next step

Every run starts here, so a run that died midway resumes where it stopped. Read the ticket per `docs/agents/issue-tracker.md`, then `git branch -a --list '*{{trackerKey}}-XXX*'`, then the MR for that branch and its CI per `docs/agents/forge.md`.

| State                                       | Next step                                   |
| ------------------------------------------- | ------------------------------------------- |
| No Plan comment on the ticket               | 1. Plan                                     |
| Plan, no branch                             | 2. Build                                    |
| Branch, no MR                               | 3. Test, 4. Review, 4b. Evidence, 5. Open the MR |
| MR open, CI red or conflicts                | 6. `fix-pipeline` skill                     |
| MR open, review threads with no reply       | 6. `fix-review-comments` skill              |
| MR open, CI running, or green and answered  | 7. Ready for review                         |
| MR merged or closed                         | Report it, do nothing                       |

A comment added to the ticket after the Plan comment that changes scope sends you back to 1.

### 1. Plan

Plan it yourself, following `.rulesync/subagents/planner.md` (Read first, Grill it, Reply). It ends in either `Asked:` with questions, or the plan.

- `Asked:` -> post the questions as one comment on the ticket, report them, stop.
- A plan -> post it, without its Core-only section, as one comment titled "Plan" (test cases where the repo's `test-plan` skill keeps them, if it has one), move the ticket to In Progress. `--ask`: show it and stop for approval.
- A Core-only section -> write the work order per `handoff.md` and drop that slice; ship the rest.

### 2. Build

Add a worktree for the ticket branch off the freshly fetched `{{mrTarget}}`, per the repo's worktree rules (its own database and Redis db). Build the plan in it yourself, following `.rulesync/subagents/builder.md` (Ground first, Tests, Done means, Rules), and the **create-plugin** skill's steps for each overlay, adapter or page slice.

- Can't finish -> post the reason as one comment on the ticket, report it, stop.
- Done -> the gate passes on HEAD and `git status` is clean, both shown by their output, before 3.

### 3. Test

Start `tester` in the worktree with the plan's test cases, for its verify pass: no videos yet. It returns an AC table.

- Every row PASS -> 4.
- Any FAIL -> fix the failing rows, then `tester` again on those rows.
- UNCHECKED rows ride along to the MR description; they do not block, except a case or a mutation row on a money, KYC, responsible-gambling or authz path: back to `tester` once to run it, still UNCHECKED -> blocker comment, report it, stop.
- A SURVIVED mutation row is a FAIL: add the test that catches it, or make the code testable, then `tester` again. A money, KYC, responsible-gambling or authz change with no mutation rows goes back to `tester` once to add them.
- A failing spec called pre-existing without its run on the base commit -> back to `tester` once to run it there. Still unrun: it is a FAIL.

### 4. Review

Run the **review** skill on the branch against `{{mrTarget}}`, without `--post`: its precheck, risk tier, request trace and evidence gate run before any reviewer reads the diff. Hand its reviewers the tester's AC table, mutation rows included, so they dig where testing could not reach. This is the self-review the MR is opened on: people reviewing the MR later read it by hand and do not run an AI review again, so nothing goes out that this step has not passed.

Every finding with a fix gets fixed, whatever its severity, but only once it holds. Dedupe across reviewers, then check each yourself before anything changes: open its `file:line` and confirm the evidence on this branch. One that doesn't hold (wrong line, the code already handles it, a claim the code doesn't show) is dropped and goes to the MR description with why. A product call the ticket doesn't settle goes to `expert`, then is fixed or rides along as an open question. Fix the rest in one go, then 3 for the cases they touch and 4 again. A later round of 4 reviews only the commits since the last one and whether each sent finding is fixed. Clean means the review skill says **APPROVED** and no finding is left that holds; only then 4b.

Rounds of 3 and 4 share one budget: three. After the third with anything still failing, post a blocker comment naming what is left, report it, stop.

### 4b. Record evidence

The code is final now, so the videos are recorded once, here, never in an earlier round. Start `tester` for its evidence pass on HEAD: every browser spec that drives an AC, new or existing, runs once with video on, `playwright-cli` only for an AC no spec drives. It returns the clip paths per AC.

- A spec that fails here -> fix it, then 3 for the cases it touches, 4 on the new commits, 4b again. That round counts against the same budget of three.
- Every AC that needs a clip has one -> 5.

### 5. Open the MR

`--ask`: report the SHA and stop for "yes push". Then run **create-pr** with the tester's AC table, the 4b videos and its Tests list. Comment the MR link on the ticket and move it to Code Review in the same turn. Draft the one-line Slack notice to `{{teamChannel}}`: emoji + MR title as a link. Then 7.

### 6. Red CI and review comments

Run the repo's `fix-pipeline` skill on a red pipeline or conflicts, `fix-review-comments` on unanswered threads from a person or a bot. No such skill in this repo: do the same per `docs/agents/forge.md`. Under `/ship` they run like this:

- Each thread is checked against the code on this branch first: correct | already handled | wrong on this branch | out of scope. Only a correct one changes code; the rest get an answer.
- A red job is reproduced locally first; fix its cause. Never skip or loosen a test.
- After every fix, the gate on HEAD, then `tester` re-runs the cases the fix touches and leaves a test that fails without it, and 4 runs on the new commits. Then 4b records again only the ACs the fix touched, and their clips replace the old ones in the MR description. Nothing is pushed untested.
- Push the ticket branch without asking (a force-push only as above). Reply per thread, in the thread itself, with what changed and the test that proves it, or why nothing changed. Resolve only a thread the fix addressed; a question or a disagreement stays open for the reviewer.

Then 7.

### 7. Ready for review

Start `node <this skill's folder>/watch-pr.mjs <branch> --until-green` as a background command, never a sleep loop in the session. It prints one line and exits when there is work:

- `failed` or `conflicts` -> 6, then watch again. Still red after three fixes -> blocker comment, report, stop.
- `threads <ids>` (unanswered for two checks in a row, from a person or a bot) -> 6 for those, then watch again. A thread the forge's AI review opens is a blocker it found on this head: it counts like a person's.
- `green` -> check the MR is ready (below), report "Ready for review:" and the MR URL, then watch again without `--until-green`.
- `merged` or `closed` -> report it, drop the worktree's database and Redis db, stop. `error ...` -> report it, stop.

Ready means: the pipeline on the last commit is green, no conflicts with `{{mrTarget}}`, every thread has an answer, no money, KYC, responsible-gambling or authz case or mutation row is UNCHECKED or SURVIVED, and the description holds the AC table, the screenshots and the UNCHECKED rows.

Keep watching until the MR merges or closes, for as long as the session lives. You never merge it: who approves and who merges is in `docs/agents/forge.md`. A caller that says it watches the MR itself (a headless run) gets the report at `green`, and you stop there; it brings the ticket back through `/ship {{trackerKey}}-XXX`, which lands on 6.

## Rules

- One ticket, one branch, one MR.
- You never grade your own work: the AC table comes from `tester`, the verdict from the review skill. Code changed after 3 means 3 runs again for the cases it touches, and 4 for the new commits.
- A subagent that stops short (no AC table, no verdict) goes back to it once, never finished by you.
- Never claim a step passed without its output: the gate from HEAD, the AC table, the review findings.
- A run you resume with a branch but no MR re-runs 3 and 4: verdicts from a dead run are gone.
- Clean up what the run started: worktree databases and Redis dbs stay for the next round until the MR merges; processes you started stop before you report.

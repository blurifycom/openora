---
name: ship
targets: ['*']
description: >
  Take one {{trackerKey}} ticket from plan to a green, reviewed MR with nobody in the loop: planner
  plans it with test cases, builder builds it, tester attacks it, the reviewers review it, then it
  pushes the ticket branch, opens the MR, moves the ticket and watches the MR until it is ready for a
  person to review. Resumable: every run reads the ticket,
  branch, MR and CI and does the next step, including fixing a red pipeline or new review comments.
  Stops only on a question or a blocker. Use on "ship {{trackerKey}}-XXX", "add feature", "deliver
  {{trackerKey}}-XXX", or /ship {{trackerKey}}-XXX [--ask].
---

# ship ({{name}})

The orchestrator: one ticket key in, a green MR in Code Review out. You own the ticket's whole delivery, plan to review: you are done when the MR is ready for a person to review it (step 7), not when it is opened. You run in the main session and are the only one who delegates. You hand each step to its subagent, read its verdict, and pick the next step yourself - never wait for a person between steps. Every subagent you start is told it starts no subagents of its own; a domain question one of them returns comes back to you, you ask `expert`, and you pass the answer on.

## Coordinates

- Jira: per `docs/agents/issue-tracker.md`, project `{{trackerKey}}`. Code forge: `{{gitRemotePath}}`, target `{{mrTarget}}`, commands in `docs/agents/forge.md`.
- `{{ossDir}}` (the linked OSS checkout) is read-only. Core-only work goes through `handoff.md`.

## Arguments

- `{{trackerKey}}-XXX` from `$ARGUMENTS`. None: ask for it, that is the one question this skill always asks.
- `--ask`: stop for approval after the plan and before the push. Without it, invoking `/ship` is the authorization for every write below - and only those.

## What ship may write without asking

- Jira, on this ticket only: the Plan comment (and its test cases where the repo's `test-plan` skill keeps them), a questions comment, a blocker comment, the MR link comment, and the transitions to In Progress and to Code Review. Nothing else: no field edits, no other transitions, no other tickets.
- Git: commits on the ticket branch `<type>/{{trackerKey}}-XXX/<slug>` and pushing it. Never a push to `{{mrTarget}}`, `stage`, `prod` or any shared branch, never a force-push.
- The forge: opening the MR for that branch and replying on its review threads.
- Slack: a one-line draft only, never sent.

## Do what the work needs, inside the worktree

Never stop to ask for something local that deleting the worktree undoes: do it, and say what you did in the reply and the MR description.

- Env: a variable the change needs goes into the worktree's `.env` with a local dev value, and into every place the repo declares one (env schema, `.env.example`, deploy docs) in the same commit. A value only a person has (a real API key, a prod URL): a dev placeholder or a mock locally, and a "Needs before deploy" line in the MR description. If no test can run without the real one, that is a blocker.
- Dependencies: add what the plan needs with the repo's package manager and commit the lockfile. A repo rule that asks for a step first (unlink a locally linked package, then link it back) is followed, so the lockfile carries no local links; it is never a reason to stop.
- Data: the worktree's own database and Redis db - create, migrate, seed and reset them freely. Migrations come from the repo's generator, generated files from its regen command.
- Processes and tools: start what the tests need on the worktree's own ports and stop it before you report; install a local tool the repo's docs name (browsers for Playwright and the like).

## Never, however blocked

Anything shared, remote, or not undone by deleting the worktree:

- Servers, stage and prod, ssh, cloud consoles, deploys, and any database that is not the worktree's own.
- CI/CD settings and variables, repo settings, other people's branches and MRs, merging.
- A database, Redis db, process or worktree this run did not create: no drop, flush, kill or delete.
- Secrets: never commit, print or invent a real-looking one; a `.env` with real values stays uncommitted.
- Gates: no `--no-verify`, no skipped or loosened test, lint rule or guard hook, no hand edit to a generated file or `node_modules`.

Blocked by one of these: `Blocked:` with what is needed and who can do it. Every subagent you start gets both lists.

## Read the state, do the next step

Every run starts here, so a run that died midway resumes where it stopped. Read the ticket per `docs/agents/issue-tracker.md`, then `git branch -a --list '*{{trackerKey}}-XXX*'`, then the MR for that branch and its CI per `docs/agents/forge.md`.

| State                                       | Next step                                   |
| ------------------------------------------- | ------------------------------------------- |
| No Plan comment on the ticket               | 1. Plan                                     |
| Plan, no branch                             | 2. Build                                    |
| Branch, no MR                               | 3. Test, then 4. Review, then 5. Open the MR |
| MR open, CI red or conflicts                | 6. `fix-pipeline` skill                     |
| MR open, review threads with no reply       | 6. `fix-review-comments` skill              |
| MR open, CI still running                   | 7. Ready for review                         |
| MR open, green, nothing unanswered          | Report "Ready for review:" and the MR URL   |
| MR merged or closed                         | Report it, do nothing                       |

A comment added to the ticket after the Plan comment that changes scope sends you back to 1.

### 1. Plan

Start `planner` with the ticket key. It returns either `Asked:` with questions, or the plan.

- `Asked:` -> post the questions as one comment on the ticket, report them, stop.
- A plan -> post it, without its Core-only section, as one comment titled "Plan" (test cases where the repo's `test-plan` skill keeps them, if it has one), move the ticket to In Progress. `--ask`: show it and stop for approval.
- A Core-only section -> write the work order per `handoff.md` and drop that slice; ship the rest.

### 2. Build

Add a worktree for the ticket branch off the freshly fetched `{{mrTarget}}`, per the repo's worktree rules (its own database and Redis db). Start `builder` in it with the plan. Run the **create-plugin** skill's steps through it for each overlay, adapter or page slice.

- `Blocked:` -> post the reason as one comment on the ticket, report it, stop.
- Done -> check its reply holds the gate output from HEAD and `git status` is clean. Missing either: send it back once to run the gate, then treat it as blocked.

### 3. Test

Start `tester` in the worktree with the plan's test cases. It returns an AC table.

- Every row PASS -> 4.
- Any FAIL -> back to `builder` with the failing rows only, then `tester` again.
- UNCHECKED rows ride along to the MR description; they do not block.
- A failing spec called pre-existing without its run on the base commit -> back to `tester` once to run it there. Still unrun: it is a FAIL.

### 4. Review

Start `quality-reviewer`, `security-reviewer` and `compliance-reviewer` in parallel on the branch diff against `{{mrTarget}}`, with the tester's AC table so they dig where testing could not reach.

Every finding with a fix gets fixed, whatever its severity, but only once it holds. Dedupe across reviewers, then check each yourself before anything changes: open its `file:line` and confirm the evidence on this branch. One that doesn't hold (wrong line, the code already handles it, a claim the code doesn't show) is dropped and goes to the MR description with why. A product call the ticket doesn't settle goes to `expert`, then is fixed or rides along as an open question. Send the rest to `builder` in one go, then 3 for the cases they touch and 4 again. A later round of 4 reviews only the commits since the last one and whether each sent finding is fixed. Clean means no finding left that holds.

Rounds of 3 and 4 share one budget: three. After the third with anything still failing, post a blocker comment naming what is left, report it, stop.

### 5. Open the MR

`--ask`: report the SHA and stop for "yes push". Then run **create-pr** with the tester's AC table, its screenshots and its Tests list. Comment the MR link on the ticket and move it to Code Review in the same turn. Draft the one-line Slack notice to `{{teamChannel}}`: emoji + MR title as a link. Then 7.

### 6. Red CI and review comments

Run the repo's `fix-pipeline` skill on a red pipeline or conflicts, `fix-review-comments` on unanswered threads from a person or a bot. No such skill in this repo: do the same per `docs/agents/forge.md`. Under `/ship` they run like this:

- Each thread is checked against the code on this branch first: correct | already handled | wrong on this branch | out of scope. Only a correct one changes code; the rest get an answer.
- A red job is reproduced locally first; `builder` fixes its cause. Never skip or loosen a test.
- Every fix goes to `builder`. Then `tester` re-runs the cases the fix touches and leaves a test that fails without it, and 4 runs on the new commits. Nothing is pushed untested.
- Push the ticket branch without asking; only a force-push still waits for a yes. Reply per thread with what changed and the test that proves it, or why nothing changed. Resolve only a thread the fix addressed; a question or a disagreement stays open for the reviewer.

Then 7.

### 7. Ready for review

Watch the MR's pipeline on its last commit until it finishes, with the forge's watch command (`docs/agents/forge.md`) run in the background, never a sleep loop. Red: 6, then watch again; still red after three fixes -> blocker comment, report, stop. Green: read the threads again, since bots and scanners comment once the pipeline ends, and run 6 for any new one.

Ready means: the pipeline on the last commit is green, no conflicts with `{{mrTarget}}`, every thread has an answer, and the description holds the AC table, the screenshots and the UNCHECKED rows. Report "Ready for review:" and the MR URL. A person's comments that come later bring the ticket back through `/ship {{trackerKey}}-XXX`, which lands on 6.

## Rules

- One ticket, one branch, one MR.
- You edit no code, commit nothing and run no gate yourself, however small the fix: every fix goes to `builder`. Code changed after 3 means 3 runs again for the cases it touches, and 4 for the new commits.
- A subagent that stops short (no gate output, uncommitted work) goes back to it once, never finished by you.
- Never claim a step passed without its output: the gate from HEAD, the AC table, the review findings.
- A run you resume with a branch but no MR re-runs 3 and 4: verdicts from a dead run are gone.
- Clean up what the run started: worktree databases and Redis dbs stay for the next round until the MR merges; processes you started stop before you report.

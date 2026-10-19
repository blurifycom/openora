---
name: ship
targets: ['*']
description: >
  Take one {{trackerKey}} ticket from plan to a green, reviewed MR with nobody in the loop: planner
  plans it with test cases, builder builds it, tester attacks it, the reviewers review it, then it
  pushes the ticket branch, opens the MR and moves the ticket. Resumable: every run reads the ticket,
  branch, MR and CI and does the next step, including fixing a red pipeline or new review comments.
  Stops only on a question or a blocker. Use on "ship {{trackerKey}}-XXX", "add feature", "deliver
  {{trackerKey}}-XXX", or /ship {{trackerKey}}-XXX [--ask].
---

# ship ({{name}})

The orchestrator: one ticket key in, a green MR in Code Review out. You run in the main session and are the only one who delegates. You hand each step to its subagent, read its verdict, and pick the next step yourself - never wait for a person between steps. Every subagent you start is told it starts no subagents of its own; a domain question one of them returns comes back to you, you ask `expert`, and you pass the answer on.

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

## Read the state, do the next step

Every run starts here, so a run that died midway resumes where it stopped. Read the ticket per `docs/agents/issue-tracker.md`, then `git branch -a --list '*{{trackerKey}}-XXX*'`, then the MR for that branch and its CI per `docs/agents/forge.md`.

| State                                       | Next step                                   |
| ------------------------------------------- | ------------------------------------------- |
| No Plan comment on the ticket               | 1. Plan                                     |
| Plan, no branch                             | 2. Build                                    |
| Branch, no MR                               | 3. Test, then 4. Review, then 5. Open the MR |
| MR open, CI red or conflicts                | 6. `fix-pipeline` skill                     |
| MR open, review threads with no reply       | 6. `fix-review-comments` skill              |
| MR open, green, nothing unanswered          | Report "nothing to do" and the MR URL       |
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

### 4. Review

Start `quality-reviewer`, `security-reviewer` and `compliance-reviewer` in parallel on the branch diff against `{{mrTarget}}`, with the tester's AC table so they dig where testing could not reach. Any `[BLOCK]` -> back to `builder` with those findings, then 3 and 4 again. `[WARN]` worth a change goes the same way; the rest ride along to the MR description.

Rounds of 3 and 4 share one budget: three. After the third with anything still failing, post a blocker comment naming what is left, report it, stop.

### 5. Open the MR

`--ask`: report the SHA and stop for "yes push". Then run **create-pr** with the tester's AC table, its screenshots and its Tests list. Comment the MR link on the ticket and move it to Code Review in the same turn. Draft the one-line Slack notice to `{{teamChannel}}`: emoji + MR title as a link.

### 6. Keep the MR green

Run the repo's `fix-pipeline` skill on a red pipeline or conflicts, `fix-review-comments` on unanswered threads. No such skill in this repo: do the same per `docs/agents/forge.md` - reproduce locally, `builder` fixes the cause and runs the gate, push the ticket branch, reply per thread. Resolve only a thread the fix addressed; a question or a disagreement stays open for the reviewer. Never skip or loosen a test.

## Rules

- One ticket, one branch, one MR.
- You edit no code, commit nothing and run no gate yourself, however small the fix: every fix goes to `builder`. Code changed after 3 means 3 runs again for the cases it touches, and 4 for the new commits.
- A subagent that stops short (no gate output, uncommitted work) goes back to it once, never finished by you.
- Never claim a step passed without its output: the gate from HEAD, the AC table, the review findings.
- A run you resume with a branch but no MR re-runs 3 and 4: verdicts from a dead run are gone.
- Clean up what the run started: worktree databases and Redis dbs stay for the next round until the MR merges; processes you started stop before you report.

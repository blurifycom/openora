---
name: handoff
description: >
  Package the current task into a self-contained prompt another agent (a
  teammate, or a fresh Claude session in another repo) can execute without this
  conversation. Gathers context from the chat so far plus live repo/environment
  state, then emits a copy-pasteable handoff. Use on "hand this off", "prompt for
  another agent", "write a handoff", when routing an OSS-core change into the
  platform repo, or /handoff [what to hand off | target agent/repo]. Produces a
  copy-pasteable prompt and may use any tool to gather context; the one hard line
  is never force-push.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - Bash
disallowed-tools:
  - Bash(git push --force:*)
  - Bash(git push -f:*)
  - Bash(git push --force-with-lease:*)
  - Bash(git push --force-with-lease)
  - Bash(git push -f)
---

# handoff - write a self-contained prompt for another agent

Turn "what we're doing" into a prompt a _stranger_ agent can act on with zero access to this
chat. The receiver has none of our context, so the prompt must carry all of it.

Common use here: an OSS-core change this consumer can't make itself. The receiver is a teammate
(agent teams on) or a new Claude session rooted in the platform checkout (agent teams off) - see
the "Fixing something in OSS core" rule. Either way it needs a standalone brief.

Optional argument = what to hand off / who to (e.g. `the OSS core publish fix`, `to a teammate in
the platform repo`, a repo path, an issue/MR#). No argument -> hand off the current in-flight task.

## Rules

- **One hard line: never force-push** (`git push --force` / `-f` / `--force-with-lease`), in any
  repo, ever - it rewrites shared history. Every other tool is fair game. The skill's main output
  is still the prompt; take further action (commit, push, spawn, launch) only on explicit confirmation.
- **Self-contained.** The receiver can't see this conversation. Inline every fact they need:
  exact paths, branch/remote names, IDs (MR/PR/ticket), commands, versions, error strings.
  No "as discussed", no "the file we changed", no unresolved pronouns.
- **Facts over memory.** Verify the moving parts against live state (git, files, CLIs) before
  writing them - don't trust half-remembered branch names or versions.
- **No secrets.** Never inline tokens, passwords, or `.env` values. Reference the env var name.
- **Scope, don't dump.** Include what's load-bearing for the task; link/name the rest.

## Step 1 - Resolve scope

From the argument + the conversation, state in one line: the goal, the target repo/dir, and (if
known) the agent type or persona best suited. If genuinely ambiguous, ask one clarifying question;
otherwise proceed with the obvious reading and note the assumption.

## Step 2 - Gather live context

Pull only what the task touches (skip irrelevant ones):

- Repo/env: `pwd`; `git -C <dir> remote -v`; `git -C <dir> branch --show-current`;
  `git -C <dir> status --short`; recent `git log --oneline -5`. Note default/target branch.
- Work state: relevant file paths (verify they exist), functions/symbols, versions/pins,
  exact error messages or failing job names, IDs (MR/PR/ticket/pipeline).
- Conventions the receiver must follow: point at the repo's rules (`CLAUDE.md`,
  `.rulesync/`, `AGENTS.md`) rather than restating them; call out any that bit us.
- What's already done vs. what remains (so they don't redo or undo work).

## Step 3 - Emit the handoff

Output one fenced markdown block (so it copy-pastes cleanly), using these headings - drop any
that don't apply, never pad:

- **Task** - one imperative sentence: the outcome wanted.
- **Environment** - repo(s), absolute path(s), remote(s), current + target branch, sibling deps.
- **Background** - the why + current state + root cause/findings already established. This is
  where prior investigation goes so it isn't repeated.
- **Do this** - ordered, concrete steps. Name files/symbols/commands. Mark decisions that need
  a human ("report the plan first, don't push").
- **Verify** - the exact commands/gates that must pass, and the expected green result.
- **Constraints** - boundaries (read-only zones, "never push without explicit yes", conventional
  commits, branch-off-target, don't touch X). Inherit the repo's rules; restate only the sharp edges.

After the block, in <=2 lines: state the key assumption you made, and offer to (a) tweak the
prompt, (b) save it to a file, or (c) launch it now (spawn a teammate with a suitable agent type,
or hand it to the operator to paste into a session rooted in the target repo). Only save or launch
on explicit confirmation.

## Quality bar

A good handoff passes this test: **hand it to someone who has never seen this repo or chat, and
they can start in under a minute and finish without asking you anything.** If a step assumes
context the block doesn't contain, fix the block.

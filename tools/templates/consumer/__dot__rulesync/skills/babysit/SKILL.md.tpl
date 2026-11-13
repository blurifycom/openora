---
name: babysit
targets: ['*']
description: >
  Look after one open MR until it merges or closes: fix a red pipeline or conflicts, check and fix
  review threads from people and bots and draft the replies, mark a draft MR ready once it is green.
  Use on "babysit", "watch this MR", "keep an eye on the PR", "take care of !123 until it merges",
  or /babysit [MR number | URL | branch] [--once].
---

# babysit ({{name}})

One open MR in, looked after until it merges or closes. Commands are in `docs/agents/forge.md`; `/ship` runs the same loop at its step 7 with its own fix rules.

## Arguments

- An MR number, URL or source branch from `$ARGUMENTS`. None: the current branch's MR.
- `--once`: one round for a caller that polls on its own (the ticket runner): handle what is there now, report, stop.

Invoking `/babysit` authorizes the writes below on that MR, and only those.

## What babysit may write without asking

- Commits on the MR's source branch and pushing it, in a worktree for that branch under `.claude/worktrees/` (reuse one `git worktree list` shows). Force-push only `--force-with-lease`, only while every commit on the remote branch past `{{mrTarget}}` is your own (`git log --format=%ae origin/{{mrTarget}}..origin/<branch>` shows only your `git config user.email`); otherwise merge `{{mrTarget}}` in.
- The `babysit` label on the MR, so a scheduler that looks after labelled MRs (`babysit.mjs --once`) takes over once this session ends; resolving a thread your fix addressed; marking a draft MR ready.
- Never: a comment, reply, review or verdict note on the MR (a hook blocks them; replies are drafts), a merge of the MR, a push to a shared branch, or a push to an MR from a fork. Someone else's MR (a colleague's, a bot's) is fine once the user named it or labelled it `babysit`: your commits go on top of theirs.

## Loop

Label the MR `babysit` if it is not yet. Start `node <this skill's folder>/babysit.mjs <branch> --until-green` as a background command, never a sleep loop in the session. `--once`: run it with `--once` in the foreground instead. It prints one line and exits when there is work:

- `failed` or `conflicts` -> the repo's `fix-pipeline` skill. Still red after three fixes in this session -> report what is left, stop.
- `threads <ids>` (unanswered for two checks in a row, from a person or a bot) -> the repo's `fix-review-comments` skill on those. Append each drafted reply (thread link, then the text) to `.claude/reviews/<branch with / as +>.replies.md` and add the thread's last-comment id to `.claude/reviews/<branch with / as +>.drafted.json` (a JSON array), both in the main checkout, so the watcher and a later run skip it.
- `green` -> a draft with every thread answered or drafted: mark it ready. Report "Ready for review:", the MR URL and the replies still waiting to be posted.
- `merged` or `closed` -> report it, remove the worktree if this skill added it, stop.
- `watched` -> another session looks after it; report that, stop.
- `error ...` -> report it, stop.

After a fix or `green`, start the watcher again (without `--until-green` once green was reported), for as long as the session lives. `--once` stops after the first line it handled.

## Fix rules

- Both fix skills run in the MR's worktree. Their push confirmation is this invocation: push the branch without asking.
- A thread is checked against the code on this branch first: correct | already handled | wrong on this branch | out of scope. Only a correct one changes code; the rest get a drafted answer.
- A red job is reproduced locally first and its cause fixed. Never skip or loosen a test, lint rule or gate.
- Every fix keeps a test that fails without it, passes the repo's full gate, and passes the `review` skill on the new commits (APPROVED) before it is pushed.
- A money, KYC, responsible-gambling, audit or authz thread is never answered "won't fix" or "accepted risk" by you: draft the question for the user and leave the thread open.

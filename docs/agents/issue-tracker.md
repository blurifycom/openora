# Issue tracker: GitHub, plus downstream trackers

Platform issues and pull requests live on GitHub (`gh` CLI, repo inferred from `git remote -v`).

## GitHub

- **Read an issue**: `gh issue view <number> --comments`. Attachments in issue bodies are image URLs - download and view them, do not judge from the alt text.
- **Read a PR**: `gh pr view <number> --comments` for intent and discussion, `gh pr diff <number>` for the patch.
- **Create / comment / label / close**: `gh issue create`, `gh issue comment`, `gh issue edit --add-label`, `gh issue close`.
- **PRs as a request surface: no.**

## Downstream operator tickets

Much of the work here is driven by tickets in a consumer's private tracker (Jira, Linear, ...). Branch names and commit subjects may carry such a key. The coordinates and read workflow for that tracker are NOT in this public repo: they live in `docs/agents/issue-tracker.local.md`, which is gitignored and per machine. When that file exists, it owns every key it declares.

Rules that hold regardless of tracker:

- Read the whole ticket before planning or reviewing against it: description, acceptance criteria, every comment, every attached image viewed as pixels, the parent, linked issues, and every linked spec page with its own images and comments. A chat thread is optional context, read only when the ticket points at it.
- Text-only reads are incomplete when attachments exist. Use a tool that returns the image bytes.
- No key resolves: say "no ticket" and review against the PR description. The fetch fails: say "no access". Never infer acceptance criteria silently.
- Keep private tracker content out of the public repo: never paste ticket text, attachments, internal URLs, or people's names into tracked files, commit bodies, PR descriptions, or review comments. A bare key in a branch or commit subject is the most that may appear.
- Reading authorizes nothing: no comments, transitions, or edits on any tracker unless the user asks for that exact write.

## When a skill says "fetch the relevant ticket"

Resolve the key (argument, PR body, PR title, branch, commit subjects), read it per the rules above via the tracker that owns it, and distill: goal in one line, acceptance criteria quoted as bullets, decisions from comments, design references, out-of-scope lines.

## When a skill says "publish to the issue tracker"

Create a GitHub issue. Never write to a downstream tracker from this repo.

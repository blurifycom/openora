# Issue tracker: the downstream tracker, plus GitHub for pull requests

Work here is requested from a consumer's private tracker, never from this repo. GitHub carries the pull requests and nothing else: this repo has no issues and does not open them.

## GitHub

- **Read a PR**: `gh pr view <number> --comments` for intent and discussion, `gh pr diff <number>` for the patch (`gh` CLI, repo inferred from `git remote -v`).
- **Issues: not used.** Do not open, comment on, or triage a GitHub issue here, and do not treat one as a spec if it exists.
- **PRs as a request surface: no.** A PR describes work already scoped somewhere else; the ticket is the request.

## Downstream operator tickets

Much of the work here is driven by tickets in a consumer's private tracker (Jira, Linear, ...). Branch names and commit subjects may carry such a key. The coordinates and read workflow for that tracker are NOT in this public repo: they live in `docs/agents/issue-tracker.local.md`, which is gitignored and per machine. When that file exists, it owns every key it declares.

Rules that hold regardless of tracker:

- Read the whole ticket before planning or reviewing against it: description, acceptance criteria, every comment, every attached image viewed as pixels, the parent, linked issues, and every linked spec page with its own images and comments. A chat thread is optional context, read only when the ticket points at it.
- The reasoning behind the criteria usually lives in the tracker's wiki, not in the ticket. When that wiki has a documentation index page - one flat list of every page and what it covers - read the index first to resolve which page owns the area, then read that page in full. The local file names the index when one exists. Searching the wiki blind costs several round-trips and still misses pages nobody thought to search for.
- A wiki index is hand-maintained and drifts. The live page tree wins when the two disagree.
- Text-only reads are incomplete when attachments exist. Use a tool that returns the image bytes.
- No key resolves: say "no ticket" and review against the PR description. The fetch fails: say "no access". Never infer acceptance criteria silently.
- Keep private tracker content out of the public repo: never paste ticket text, attachments, internal URLs, or people's names into tracked files, commit bodies, PR descriptions, or review comments. A bare key in a branch or commit subject is the most that may appear.
- Reading authorizes nothing: no comments, transitions, or edits on any tracker unless the user asks for that exact write.

## When a skill says "fetch the relevant ticket"

Resolve the key (argument, PR body, PR title, branch, commit subjects), read it per the rules above via the tracker that owns it, and distill: goal in one line, acceptance criteria quoted as bullets, decisions from comments, design references, out-of-scope lines.

## Writing anywhere

Don't. Reading a tracker or a wiki authorizes no write back to either, and this repo opens no GitHub issues. A finding goes in the PR review or back to the user, who decides where it is filed.

#!/usr/bin/env node
// PreToolUse guard: a GitHub pull request that builds on another feature branch goes up as a
// native stacked PR (`gh stack`, the github/gh-stack extension), not as a plain PR whose base is
// that branch. `gh pr create --base <b>` and `gh pr edit --base <b>` are denied when <b> is not a
// shared branch. Without `--base` the PR targets the default branch and passes.
//
// ponytail: shared branches are a fixed list; a repo with another trunk name adds it here.

import { deny, extractCommand, readPayload } from './_shared.mjs';

const SHARED = /^(?:origin\/)?(?:main|master|dev|develop|stage|staging|prod|production)$/;
// Each `gh pr create|edit` command up to the next separator, then every `--base`/`-B` in it,
// glued (`-Bfeat/x`) or not: a repeated flag must not hide a feature base behind a shared one.
const PR_COMMAND =
  /(?:^|[;&|\n(]\s*)(?:(?:env\s+)?\w+=\S*\s+)*(?:command\s+)?(?:\S*\/)?gh(?:\s+(?:-R|--repo)\s+\S+)?\s+pr\s+(?:create|edit)\b([^;&|\n]*)/g;
const BASE_FLAG = /\s(?:--base(?:=|\s+)|-B\s*)['"]?([^\s'"]+)/g;

// Quoted prose (a title or body) is blanked so a `--base` inside it never counts.
const command = extractCommand(readPayload()).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) =>
  /\s/.test(quoted) ? '""' : quoted,
);
// Every PR command in a chain is judged, not only the first.
const base = [...command.matchAll(PR_COMMAND)]
  .flatMap((pr) => [...pr[1].matchAll(BASE_FLAG)].map((flag) => flag[1]))
  .find((name) => !SHARED.test(name));
if (base) {
  deny(
    `Blocked: a PR based on \`${base}\` is a stack. Use \`gh stack\` (gh extension install github/gh-stack): \`gh stack init\` or \`gh stack init <branches...>\`, \`gh stack add <branch>\`, then \`gh stack submit --auto\` (layers open as drafts). Review each layer on its own; the merge bot merges.`,
  );
}
process.exit(0);

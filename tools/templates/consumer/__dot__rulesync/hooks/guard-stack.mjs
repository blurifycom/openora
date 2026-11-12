#!/usr/bin/env node
// PreToolUse guard: a GitHub pull request that builds on another feature branch goes up as a
// native stacked PR (`gh stack`, the github/gh-stack extension), not as a plain PR whose base is
// that branch. `gh pr create --base <b>` and `gh pr edit --base <b>` are denied when <b> is not a
// shared branch. Without `--base` the PR targets the default branch and passes.
//
// ponytail: shared branches are a fixed list; a repo with another trunk name adds it here.

import { deny, extractCommand, readPayload } from './_shared.mjs';

const SHARED = /^(?:origin\/)?(?:main|master|dev|develop|stage|staging|prod|production)$/;
const PR_WITH_BASE =
  /(?:^|[;&|\n(]\s*)(?:(?:env\s+)?\w+=\S*\s+)*gh(?:\s+(?:-R|--repo)\s+\S+)?\s+pr\s+(?:create|edit)\b[^;&|\n]*?\s(?:--base|-B)(?:=|\s+)['"]?([^\s'"]+)/;

// Quoted prose (a title or body) is blanked so a `--base` inside it never counts.
const command = extractCommand(readPayload()).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) =>
  /\s/.test(quoted) ? '""' : quoted,
);
const base = PR_WITH_BASE.exec(command)?.[1];
if (base && !SHARED.test(base)) {
  deny(
    `Blocked: a PR based on \`${base}\` is a stack. Use \`gh stack\` (gh extension install github/gh-stack): \`gh stack init\` or \`gh stack init <branches...>\`, \`gh stack add <branch>\`, then \`gh stack submit\`. Review each layer on its own; the merge bot merges.`,
  );
}
process.exit(0);

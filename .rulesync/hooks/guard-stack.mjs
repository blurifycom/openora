#!/usr/bin/env node
// PreToolUse guard: a GitHub pull request that builds on another feature branch goes up as a
// native stacked PR (`gh stack`, the github/gh-stack extension), not as a plain PR whose base is
// that branch. `gh pr create|new|edit --base <b>` is denied when <b> is not a
// shared branch. Without `--base` the PR targets the default branch and passes.
//
// ponytail: shared branches are a fixed list; a repo with another trunk name adds it here.

import { deny, extractCommand, readPayload } from './_shared.mjs';

const SHARED = /^(?:origin\/)?(?:main|master|dev|develop|stage|staging|prod|production)$/;
// Every `--base`/`-B` is judged, glued (`-Bfeat/x`) or not: a repeated flag must not hide a
// feature base behind a shared one. `-R <repo>` goes before or after `pr`; `new` aliases `create`.
const REPO = String.raw`(?:\s+(?:-R\s*|--repo(?:=|\s+))\S+)?`;
const PR_COMMAND = new RegExp(
  String.raw`(?:^|[;&|\n(])\s*(?:(?:env\s+)?\w+=\S*\s+)*(?:(?:command|env|time|nohup)\s+)?(?:\S*\/)?gh${REPO}\s+pr${REPO}\s+(?:create|new|edit)\b([^;&|\n]*)`,
  'g',
);
const BASE_FLAG = /\s(?:--base(?:=|\s+)|-[defw]*B(?:=|\s*))['"]?([^\s'"]+)/g;

// Quoted prose (a title or body) or a quoted separator is blanked so a `--base` inside it never
// counts and never cuts a flag list short.
const command = extractCommand(readPayload()).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) =>
  /[\s;&|(){}]/.test(quoted) ? '""' : quoted,
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

import { deny, extractCommand, readPayload } from './_shared.mjs';

const SHARED = /^(?:origin\/)?(?:main|master|dev|develop|stage|staging|prod|production)$/;
const REPO = String.raw`(?:\s+(?:-R\s*|--repo(?:=|\s+))\S+)?`;
const PR_COMMAND = new RegExp(
  String.raw`(?:^|[;&|\n(])\s*(?:(?:env\s+)?\w+=\S*\s+)*(?:(?:command|env|time|nohup)\s+)?(?:\S*\/)?gh${REPO}\s+pr${REPO}\s+(?:create|new|edit)\b([^;&|\n]*)`,
  'g',
);
const BASE_FLAG = /\s(?:--base(?:=|\s+)|-[defw]*B(?:=|\s*))['"]?([^\s'"]+)/g;

const command = extractCommand(readPayload()).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) =>
  /[\s;&|(){}]/.test(quoted) ? '""' : quoted,
);
const base = [...command.matchAll(PR_COMMAND)]
  .flatMap((pr) => [...pr[1].matchAll(BASE_FLAG)].map((flag) => flag[1]))
  .find((name) => !SHARED.test(name));
if (base) {
  deny(
    `Blocked: a PR based on \`${base}\` is a stack. Use \`gh stack\` (gh extension install github/gh-stack): \`gh stack init\` or \`gh stack init <branches...>\`, \`gh stack add <branch>\`, then \`gh stack submit --auto\` (layers open as drafts). Review each layer on its own; the merge bot merges.`,
  );
}
process.exit(0);

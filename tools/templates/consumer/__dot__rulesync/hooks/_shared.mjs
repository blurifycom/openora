// Shared helpers for the cross-CLI hook guards.
//
// One script serves Claude Code, Codex CLI, and Gemini CLI. Each passes the tool
// call as JSON on stdin:
//   Claude / Gemini : { tool_name, tool_input: { command?, file_path? } }
//   Codex           : same, except an edit is { tool_name: "apply_patch", tool_input: { command: "<patch>" } },
//                     the paths only in its "*** Add File: <path>" style headers; an Edit|Write
//                     matcher matches apply_patch
//
// Deny is universal: exit code 2 + a message on stderr. Every other path exits 0
// (allow). We FAIL OPEN on any parse error or uncertainty, so a crashing guard
// never blocks real work; we only block on a positive match.

import { readFileSync } from 'node:fs';

/** Read the hook payload from stdin; {} on any error. */
export function readPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

const rawCommand = (payload) => String(payload.tool_input?.command ?? '');

// Only the tool name tells a patch from a shell command: a Bash command can carry patch text too.
const isPatch = (payload) => payload.tool_name === 'apply_patch';

/** The shell command string for this tool call, across tool shapes ('' if none or a patch). */
export function extractCommand(payload) {
  return isPatch(payload) ? '' : rawCommand(payload);
}

/** Every file an edit/write tool call touches, across tool shapes ([] if none). */
export function extractFilePaths(payload) {
  if (isPatch(payload)) {
    return [...rawCommand(payload).matchAll(PATCH_PATH)].map((match) => match[1].trim());
  }
  const ti = payload.tool_input ?? {};
  const filePath = ti.file_path ?? ti.path;
  return filePath ? [String(filePath)] : [];
}

/** Deny the tool call (works on Claude, Codex, Gemini). */
export function deny(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(2);
}

// Shared helpers for the cross-CLI hook guards.
//
// One script serves Claude Code and Codex CLI. Both pass the tool call as JSON on
// stdin: { tool_name, tool_input: { command?, file_path? } }.
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

/** The shell command string for this tool call ('' if none). */
export function extractCommand(payload) {
  return String(payload.tool_input?.command ?? '');
}

/** The target file path for an edit/write tool call ('' if none). */
export function extractFilePath(payload) {
  const ti = payload.tool_input ?? {};
  return String(ti.file_path ?? ti.path ?? '');
}

/** Deny the tool call (works on Claude and Codex). */
export function deny(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(2);
}

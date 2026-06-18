// Shared helpers for the cross-CLI hook guards.
//
// One script serves Claude Code, Copilot CLI, Codex CLI, and Gemini CLI. Each
// passes the tool call as JSON on stdin but with a slightly different shape:
//   Claude / Codex : { tool_name, tool_input: { command?, file_path? } }
//   Copilot        : { toolName,  toolArgs: "<json-string>" | object }
//   Gemini         : { toolName/tool_name, ... } (best-effort)
//
// Deny is universal: exit code 2 + a message on stderr. Every other path exits 0
// (allow). We FAIL OPEN on any parse error or uncertainty - Copilot's preToolUse
// is fail-closed, so a crashing/slow guard would block real work; we never do
// that, we only block on a positive match.

import { readFileSync } from 'node:fs';

export function readPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function toolArgsObject(payload) {
  const a = payload.toolArgs;
  if (typeof a === 'string') {
    try {
      return JSON.parse(a);
    } catch {
      return {};
    }
  }
  return a && typeof a === 'object' ? a : {};
}

export function extractCommand(payload) {
  const ti = payload.tool_input ?? {};
  const ca = toolArgsObject(payload);
  return String(ti.command ?? ca.command ?? '');
}

export function extractFilePath(payload) {
  const ti = payload.tool_input ?? {};
  const ca = toolArgsObject(payload);
  return String(
    ti.file_path ??
      ti.path ??
      ca.path ??
      ca.filePath ??
      ca.file ??
      ca.targetFile ??
      ca.target_file ??
      '',
  );
}

export function deny(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(2);
}

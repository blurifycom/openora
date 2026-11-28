import { readFileSync } from 'node:fs';

export function readPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

export function extractCommand(payload) {
  return String(payload.tool_input?.command ?? '');
}

export function extractFilePath(payload) {
  const ti = payload.tool_input ?? {};
  return String(ti.file_path ?? ti.path ?? '');
}

export function deny(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(2);
}

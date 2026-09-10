#!/usr/bin/env node
// PreToolUse guard (Claude / Copilot CLI / Codex CLI / Gemini CLI - rulesync renders the same
// script for every hook target, so the rule below holds identically in each tool).
// Enforces the HARD RULE: the linked OSS checkout and node_modules are read-only. The one
// exception is a git worktree under <oss>/.worktrees/ - the sanctioned place to change OSS
// code from this repo (oss-boundaries rule, `pnpm oss:worktree`). Reads are always allowed.

import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCommand, extractFilePath, readPayload, deny } from './_shared.mjs';

const payload = readPayload();

// Paths resolve from the repo root (this file lives in <root>/.rulesync/hooks/), so an
// absolute path - what most tools send - is caught as well as the relative form.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OSS_RELATIVE = String.raw`{{ossFromRoot}}`;
const OSS = resolve(ROOT, OSS_RELATIVE);
const WORKTREES = join(OSS, '.worktrees');

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OSS_PATH = `(?:${escape(OSS)}|${escape(OSS_RELATIVE)})`;
const PROTECTED = `(?:${OSS_PATH}|node_modules\\b)`;
// A path into a worktree with no `..` hop and no node_modules segment is sanctioned; it is
// masked out before the write checks run, so the rest of the command is still judged.
const WORKTREE_TOKEN = new RegExp(
  String.raw`${OSS_PATH}/\.worktrees/(?![^\s'"|;&]*(?:\.\.|node_modules))[^\s'"|;&]*`,
  'g',
);

const HOW_TO_CHANGE_OSS =
  'To change OSS code, run `pnpm oss:worktree <branch>` and edit inside ' +
  `${OSS_RELATIVE}/.worktrees/ (rule: oss-boundaries). Otherwise extend from the OUTSIDE ` +
  '(overlay plugin, adapter rebinding, UI plugin, config).';

// 1) Shell command writing into a protected path (sed -i, redirect, tee, rm, ...).
const command = extractCommand(payload).replace(WORKTREE_TOKEN, '<oss-worktree>');
if (command) {
  const writeToCore = [
    [new RegExp(String.raw`\b(?:sed|perl)\b[^|;&]*\s-\w*i\w*\b[^|;&]*${PROTECTED}`), 'in-place edit (sed/perl -i)'],
    [new RegExp(String.raw`(?:>>?|>\|)\s*['"]?[^'"\s|;&]*${PROTECTED}`), 'shell redirection'],
    [new RegExp(String.raw`\btee\b\s+(?:-a\s+)?['"]?[^'"\s|;&]*${PROTECTED}`), 'tee'],
    [new RegExp(String.raw`\b(?:rm|truncate|dd|chmod|chown|unlink|shred|mv)\b[^|;&]*${PROTECTED}`), 'destructive file op'],
  ];
  const hit = writeToCore.find(([pattern]) => pattern.test(command));
  if (hit) {
    deny(`Blocked: this ${hit[1]} writes into the OSS checkout or node_modules, which are read-only here. ${HOW_TO_CHANGE_OSS}`);
  }
}

// 2) Direct file edit/write whose target resolves inside a protected path.
const filePath = extractFilePath(payload);
if (filePath) {
  const target = resolve(payload.cwd ?? process.cwd(), filePath);
  const isInside = (dir) => target.startsWith(dir + sep);
  const inNodeModules = /(?:^|[\\/])node_modules(?:[\\/]|$)/.test(target);
  if (inNodeModules || (isInside(OSS) && !isInside(WORKTREES))) {
    deny(`Blocked: ${filePath} is inside the OSS checkout or node_modules, which are read-only here. ${HOW_TO_CHANGE_OSS}`);
  }
}

process.exit(0);

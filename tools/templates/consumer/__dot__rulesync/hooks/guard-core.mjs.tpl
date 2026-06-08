#!/usr/bin/env node
// PreToolUse guard (Claude / Copilot CLI / Codex CLI / Gemini CLI).
// Enforces the HARD RULE: never modify OSS core. Blocks shell write-primitives
// and direct file edits that target the linked OSS checkout or node_modules.
// Reads/blocks are allowed; only writes into protected paths are denied.

import { extractCommand, extractFilePath, readPayload, deny } from './_shared.mjs';

const payload = readPayload();

// The linked OSS core checkout (baked in at generation time) plus any node_modules.
const ossPath = String.raw`{{ossFromRoot}}`;
const escapedOss = ossPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PROTECTED = `(?:${escapedOss}|node_modules\\b)`;

// 1) Shell command writing into a protected path (sed -i, redirect, tee, rm, ...).
const command = extractCommand(payload);
if (command) {
  const writeToCore = [
    [new RegExp(String.raw`\b(?:sed|perl)\b[^|;&]*\s-\w*i\w*\b[^|;&]*(?:${PROTECTED})`), 'in-place edit (sed/perl -i)'],
    [new RegExp(String.raw`(?:>>?|>\|)\s*['"]?[^'"\s|;&]*(?:${PROTECTED})`), 'shell redirection'],
    [new RegExp(String.raw`\btee\b\s+(?:-a\s+)?['"]?[^'"\s|;&]*(?:${PROTECTED})`), 'tee'],
    [new RegExp(String.raw`\b(?:rm|truncate|dd|chmod|chown|unlink|shred|mv)\b[^|;&]*(?:${PROTECTED})`), 'destructive file op'],
  ];
  const hit = writeToCore.find(([re]) => re.test(command));
  if (hit) {
    deny(
      `Blocked: this ${hit[1]} writes into OSS core / node_modules, which is read-only here. ` +
        'Extend the platform from the OUTSIDE (overlay plugin, adapter rebinding, UI plugin, config). ' +
        'If it can only be fixed in core, STOP and report it as an upstream OSS issue.',
    );
  }
}

// 2) Direct file edit/write whose target is inside a protected path.
const filePath = extractFilePath(payload);
if (filePath && new RegExp(PROTECTED).test(filePath)) {
  deny(
    `Blocked: ${filePath} is inside OSS core / node_modules, which is read-only here. ` +
      'Extend from the OUTSIDE (overlay, adapter, UI plugin, config), or report an upstream OSS issue.',
  );
}

process.exit(0);

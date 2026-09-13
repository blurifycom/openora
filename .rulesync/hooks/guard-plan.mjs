#!/usr/bin/env node
// PreToolUse guard (Claude / Copilot CLI / Codex CLI).
//
// `docs/standards/skills/delivery.md` says "read-only until the plan is
// explicitly approved" and "never push without explicit per-action
// confirmation". Both were prose. Built-in plan mode enforces the same thing at
// the tool layer, but it is mutually exclusive with bypassPermissions, so the
// headless and bypass runs that most need a gate had none.
//
// A PreToolUse hook fires before the permission-mode check in every mode, so a
// denial here holds under `--dangerously-skip-permissions` and in `claude -p`.
//
// OFF unless OPENORA_PLAN_GATE is set, so an ordinary interactive session is
// untouched. Turn it on for an unattended run:
//
//   OPENORA_PLAN_GATE=1 claude -p "..." --permission-mode bypassPermissions
//
// Approve by creating the marker yourself, outside the agent's reach - in Claude
// Code type `!touch .claude/.plan-approved`, which runs in your shell rather
// than as a tool call. The agent cannot create it: writing it, or naming it in a
// shell command, is denied too. That is the whole point - an approval the
// approver can forge is not one.
//
// Fail-open on any parse error, matching the other guards.

import { existsSync } from 'node:fs';
import { extractCommand, extractFilePath, readPayload, deny } from './_shared.mjs';

if (!process.env.OPENORA_PLAN_GATE) {
  process.exit(0);
}

const MARKER = '.claude/.plan-approved';
const APPROVED = existsSync(MARKER);

const payload = readPayload();
const toolName = String(payload.tool_name ?? payload.toolName ?? '');
const command = extractCommand(payload);
const filePath = extractFilePath(payload);

const HOW = `Create it yourself with \`!touch ${MARKER}\` once you have approved the plan.`;

// Self-approval, whether by writing the marker or shelling out to it. Denied
// even after approval: the marker is the approver's to manage, not the agent's.
if (filePath.includes('.plan-approved') || command.includes('.plan-approved')) {
  deny(
    `Blocked: ${MARKER} is the plan-approval marker and only a human creates or removes it. ${HOW}`,
  );
}

if (APPROVED) {
  process.exit(0);
}

const WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const PUSHES = /\bgit\s+(push|commit)\b/;

if (WRITE_TOOLS.test(toolName)) {
  deny(
    `Blocked: the plan gate is on and no approval is recorded, so this session is read-only. ` +
      `Present the plan - goal, acceptance criteria, locked decisions, exact surface, risks, task breakdown - and wait. ${HOW}`,
  );
}

if (PUSHES.test(command)) {
  deny(
    `Blocked: the plan gate is on and no approval is recorded, so nothing commits or pushes. ${HOW}`,
  );
}

process.exit(0);

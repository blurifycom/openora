#!/usr/bin/env node
// PreToolUse(Task) guard: keep the orchestrator from spawning a GENERIC subagent
// (general-purpose / claude) for work a roster agent is purpose-built for. The
// Agent roster in AGENTS.md is prose the model sometimes skips out of habit; this
// is the deterministic backstop.
//
// Conservative by design: it acts ONLY when (a) the chosen subagent is generic AND
// (b) the task text contains a HIGH-SIGNAL phrase that maps unambiguously to one
// roster agent. Generic verbs ("implement", "test", "review") are deliberately not
// triggers - we never block a genuine general-purpose task. Fail-open on anything
// unexpected (a crashing guard must never wedge real work).
//
// On a match: exit 2 with a message telling the model to re-issue the Task with the
// right subagent_type. The model then either switches agent (the goal) or rephrases
// to make explicit that the task does not fit - no hard deadlock.

import { readPayload } from './_shared.mjs';

const payload = readPayload();
const ti = payload.tool_input ?? {};
const sub = String(ti.subagent_type ?? '').toLowerCase();

// A specific subagent choice is always allowed - only police the generic ones.
const GENERIC = new Set(['general-purpose', 'claude', '']);
if (!GENERIC.has(sub)) process.exit(0);

const text = `${ti.description ?? ''}\n${ti.prompt ?? ''}`.toLowerCase();

// High-signal phrase -> the roster agent that owns that work. Keep each pattern
// SPECIFIC; err toward missing a case over false-blocking a generic task.
const ROUTES = [
  { agent: 'qa', re: /\b(playwright|e2e test|end-to-end test|e2e coverage)\b/ },
  {
    agent: 'security-reviewer',
    re: /\bsecurity (review|audit)\b|\baudit\b[^.]*\bvulnerabilit|\b(authz|owasp)\b/,
  },
  {
    agent: 'contract-reviewer',
    re: /\b(breaking change|boundary violation|schema drift)\b|\breview (the )?(pr|diff|changed files)\b/,
  },
  {
    agent: 'docs',
    re: /\b(docs? drift|documentation drift|update (the )?docs|sync the docs)\b|\bagents\.md\b/,
  },
  {
    agent: 'module-author',
    re: /\bscaffold (a |the )?module\b|\bnew module\b|\bauthor (a |the )?module\b/,
  },
  {
    agent: 'plugin-author',
    re: /\b(overlay plugin|defineplugin|extension plugin)\b|\bscaffold (a |the )?plugin\b/,
  },
  {
    agent: 'operator',
    re: /\b(operator readiness|launch blocker|readiness audit)\b|\bas an? operator\b/,
  },
  {
    agent: 'expert',
    re: /\b(acceptance criteria|responsible gaming|regulatory requirement)\b/,
  },
  {
    agent: 'quality-reviewer',
    re: /\b(quality review|code quality|over-engineer(ed|ing)?|simplification review|duplication review)\b/,
  },
];

const hit = ROUTES.find((r) => r.re.test(text));
if (!hit) process.exit(0);

process.stderr.write(
  `Use the \`${hit.agent}\` subagent for this task, not \`${sub || 'general-purpose'}\`. ` +
    `It is pre-scoped for this work (tools + model + brief) - see the Agent roster in AGENTS.md. ` +
    `Re-issue the Task with subagent_type: "${hit.agent}". ` +
    `If it genuinely does not fit ${hit.agent}, rephrase the description to say why.\n`,
);
process.exit(2);

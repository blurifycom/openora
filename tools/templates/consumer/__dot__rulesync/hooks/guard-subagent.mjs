#!/usr/bin/env node
// PreToolUse(Task) guard: keep the orchestrator from spawning a GENERIC subagent
// (general-purpose / claude) for work a roster agent is purpose-built for. The
// Agent roster in AGENTS.md is prose the model sometimes skips out of habit; this
// is the deterministic backstop.
//
// Conservative by design: it acts ONLY when (a) the chosen subagent is generic AND
// (b) the task text contains a HIGH-SIGNAL phrase that maps unambiguously to one
// roster agent. Generic verbs ("implement", "test", "review") are deliberately not
// triggers. Fail-open on anything unexpected (a crashing guard must never wedge work).

import { readPayload } from './_shared.mjs';

const payload = readPayload();
const ti = payload.tool_input ?? {};
const sub = String(ti.subagent_type ?? '').toLowerCase();

const GENERIC = new Set(['general-purpose', 'claude', '']);
if (!GENERIC.has(sub)) process.exit(0);

const text = `${ti.description ?? ''}\n${ti.prompt ?? ''}`.toLowerCase();

// High-signal phrase -> the roster agent that owns it. Keep each pattern SPECIFIC;
// err toward missing a case over false-blocking a generic task.
const ROUTES = [
  { agent: 'qa', re: /\b(playwright|e2e test|end-to-end test|e2e coverage)\b/ },
  {
    agent: 'debugger',
    re: /\b(build (failure|error)|turbopack|tsc error|module resolution|runtime error|stack trace)\b/,
  },
  {
    agent: 'expert',
    re: /\b(acceptance criteria|responsible gaming|regulatory requirement|jurisdiction)\b/,
  },
  {
    agent: 'builder',
    re: /\b(overlay plugin|adapter swap|swap (the )?(kyc|psp|payment|notification)|extensions?\.config|mount (a |the )?page)\b/,
  },
  {
    agent: 'deployer',
    re: /\b(dockerfile|containerize|deploy pipeline|deploy to (ecs|kubernetes|fly|railway|render)|ci\/cd deploy|helm chart)\b/,
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

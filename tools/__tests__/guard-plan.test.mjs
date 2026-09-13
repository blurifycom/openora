// Feeds the real hook a tool-call payload on stdin and asserts the exit code.
// Run: node --test tools/__tests__/guard-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hook = join(repoRoot, '.rulesync/hooks/guard-plan.mjs');
const marker = join(repoRoot, '.claude/.plan-approved');

const DENIED = 2;
const ALLOWED = 0;

function run(payload, { gate = true, approved = false } = {}) {
  // The suite must never clobber a marker a human put there.
  assert.equal(existsSync(marker), false, 'a plan-approval marker already exists');

  if (approved) {
    writeFileSync(marker, '');
  }

  try {
    return spawnSync('node', [hook], {
      cwd: repoRoot,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: gate
        ? { ...process.env, OPENORA_PLAN_GATE: '1' }
        : { ...process.env, OPENORA_PLAN_GATE: '' },
    }).status;
  } finally {
    rmSync(marker, { force: true });
  }
}

const edit = { tool_name: 'Edit', tool_input: { file_path: 'README.md' } };
const push = { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } };
const read = { tool_name: 'Bash', tool_input: { command: 'git status -s' } };

test('does nothing when the gate is off', () => {
  assert.equal(run(edit, { gate: false }), ALLOWED);
  assert.equal(run(push, { gate: false }), ALLOWED);
});

test('denies an edit while the plan is unapproved', () => {
  assert.equal(run(edit), DENIED);
});

test('denies a commit or push while the plan is unapproved', () => {
  assert.equal(run(push), DENIED);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }), DENIED);
});

test('leaves read-only work alone so the plan can be researched', () => {
  assert.equal(run(read), ALLOWED);
});

test('allows writes and pushes once the marker exists', () => {
  assert.equal(run(edit, { approved: true }), ALLOWED);
  assert.equal(run(push, { approved: true }), ALLOWED);
});

test('refuses to let the agent approve itself, before or after approval', () => {
  const touch = { tool_name: 'Bash', tool_input: { command: 'touch .claude/.plan-approved' } };
  const write = { tool_name: 'Write', tool_input: { file_path: '.claude/.plan-approved' } };

  assert.equal(run(touch), DENIED);
  assert.equal(run(write), DENIED);
  assert.equal(run(touch, { approved: true }), DENIED);
});

test('reads the Copilot payload shape too', () => {
  assert.equal(run({ toolName: 'Write', toolArgs: '{"path":"a.ts"}' }), DENIED);
});

test('fails open on an unparseable payload', () => {
  const status = spawnSync('node', [hook], {
    cwd: repoRoot,
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, OPENORA_PLAN_GATE: '1' },
  }).status;

  assert.equal(status, ALLOWED);
});

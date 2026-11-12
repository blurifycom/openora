// The consumer guard-stack hook sends a PR that builds on a feature branch through `gh stack`:
// a plain `gh pr create|edit --base <feature branch>` is denied, a shared base passes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(
  new URL('../templates/consumer/__dot__rulesync/hooks/guard-stack.mjs', import.meta.url),
);
const exitCode = (command) =>
  spawnSync('node', [guard], { input: JSON.stringify({ tool_input: { command } }) }).status;
const DENIED = 2;
const ALLOWED = 0;

test('a PR on a shared branch or the default branch is allowed', () => {
  assert.equal(exitCode('gh pr create --fill'), ALLOWED);
  assert.equal(exitCode('gh pr create --base dev --title "feat: x"'), ALLOWED);
  assert.equal(exitCode('gh pr create -B origin/main'), ALLOWED);
  assert.equal(exitCode('gh pr edit 12 --base=stage'), ALLOWED);
  assert.equal(exitCode('gh stack submit'), ALLOWED);
  assert.equal(exitCode('git commit -m "gh pr create --base feat/a"'), ALLOWED);
  assert.equal(exitCode('gh pr create --title "rebase onto --base feat" --base dev'), ALLOWED);
});

test('a PR based on a feature branch is denied', () => {
  assert.equal(exitCode('gh pr create --base feat/a --fill'), DENIED);
  assert.equal(exitCode('gh pr create --title "x" -B "feat/a"'), DENIED);
  assert.equal(exitCode('gh pr edit 12 --base=feat/a'), DENIED);
  assert.equal(exitCode('cd repo && gh pr create --base origin/feat/a'), DENIED);
  assert.equal(exitCode('gh -R o/r pr create --base feat/a'), DENIED);
});

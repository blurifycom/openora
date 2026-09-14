// Builds a throwaway git repo with known-bad pointers and runs the real script
// against it. Run: node --test tools/__tests__/verify-references.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '../lint/verify-references.ts');

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'verify-references-'));

  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }

  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });

  return root;
}

function run(files) {
  const root = fixture({
    'package.json': JSON.stringify({ scripts: { verify: 'true' } }),
    '.rulesync/subagents/dev.md': '# dev\n',
    'docs/adr/0001-first.md': '# ADR-0001\n',
    ...files,
  });

  const result = spawnSync('pnpm', ['exec', 'tsx', script, root], { encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });

  return { code: result.status, output: result.stdout + result.stderr };
}

test('passes when every pointer resolves', () => {
  const { code } = run({
    '.rulesync/skills/review/SKILL.md':
      '---\nname: review\ndescription: x\n---\n\n[doc](../../subagents/dev.md)\n',
  });
  assert.equal(code, 0);
});

test('flags a markdown link whose target is gone', () => {
  const { code, output } = run({
    'docs/guides/a.md': '[gone](./nope.md)\n',
  });
  assert.equal(code, 1);
  assert.match(output, /link target does not exist: \.\/nope\.md/);
});

test('flags an anchor that matches no heading', () => {
  const { code, output } = run({
    'docs/guides/a.md': '[bad anchor](../adr/0001-first.md#no-such-heading)\n',
  });
  assert.equal(code, 1);
  assert.match(output, /link anchor not found/);
});

test('accepts an anchor that matches a heading', () => {
  const { code } = run({
    'docs/guides/a.md': '[good anchor](../adr/0001-first.md#adr-0001)\n',
  });
  assert.equal(code, 0);
});

test('flags a backticked repo path that does not exist', () => {
  const { code, output } = run({
    '.rulesync/rules/a.md': 'Compose it in `tools/build-contract.ts` first.\n',
  });
  assert.equal(code, 1);
  assert.match(output, /path does not exist: tools\/build-contract\.ts/);
});

test('flags a pnpm script that is not in package.json', () => {
  const { code, output } = run({
    '.rulesync/commands/a.md': 'Run `pnpm check:nothing` before pushing.\n',
  });
  assert.equal(code, 1);
  assert.match(output, /pnpm script does not exist: pnpm check:nothing/);
});

test('accepts a pnpm script that is in package.json', () => {
  const { code } = run({ '.rulesync/commands/a.md': 'Run `pnpm verify`.\n' });
  assert.equal(code, 0);
});

test('flags a skill whose name does not match its directory', () => {
  const { code, output } = run({
    '.rulesync/skills/review/SKILL.md': '---\nname: reviewer\ndescription: x\n---\n',
  });
  assert.equal(code, 1);
  assert.match(output, /does not match directory/);
});

test('flags two ADRs sharing a number', () => {
  const { code, output } = run({
    'docs/adr/0001-second.md': '# ADR-0001\n',
  });
  assert.equal(code, 1);
  assert.match(output, /ADR number 0001 is used by 2 files/);
});

test('flags a roster entry with no subagent file', () => {
  const { code, output } = run({
    '.rulesync/rules/overview.md': '## The roster\n\nDelegate to `ghost` (does not exist).\n',
  });
  assert.equal(code, 1);
  assert.match(output, /roster names an agent with no subagent file: ghost/);
});

test('ignores links to the published docs site', () => {
  const { code } = run({ 'docs/platform/a.md': '[api](/docs/api)\n' });
  assert.equal(code, 0);
});

// The consumer guard-core hook is the only thing between an agent and the linked OSS checkout.
// Render the template into a throwaway consumer next to a throwaway OSS dir and drive it with
// real hook payloads: the main checkout and node_modules stay denied, a worktree is allowed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooks = fileURLToPath(
  new URL('../templates/consumer/__dot__rulesync/hooks/', import.meta.url),
);
// realpath: the hook resolves its own location through symlinks (macOS /var -> /private/var).
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'guard-core-')));
const consumer = join(sandbox, 'consumer');
const oss = join(sandbox, 'oss');
const guard = join(consumer, '.rulesync', 'hooks', 'guard-core.mjs');

mkdirSync(join(consumer, '.rulesync', 'hooks'), { recursive: true });
mkdirSync(oss);
copyFileSync(join(hooks, '_shared.mjs'), join(consumer, '.rulesync', 'hooks', '_shared.mjs'));
writeFileSync(
  guard,
  readFileSync(join(hooks, 'guard-core.mjs.tpl'), 'utf8').replaceAll('{{ossFromRoot}}', '../oss'),
);
after(() => rmSync(sandbox, { recursive: true, force: true }));

const exitCode = (toolInput) =>
  spawnSync('node', [guard], { cwd: consumer, input: JSON.stringify({ tool_input: toolInput }) })
    .status;
const DENIED = 2;
const ALLOWED = 0;

test('edits in the main OSS checkout are denied, by relative and by absolute path', () => {
  assert.equal(exitCode({ file_path: '../oss/packages/core/src/a.ts' }), DENIED);
  assert.equal(exitCode({ file_path: join(oss, 'packages/core/src/a.ts') }), DENIED);
});

test('edits inside an OSS worktree are allowed', () => {
  assert.equal(
    exitCode({ file_path: join(oss, '.worktrees/feat+x/packages/core/src/a.ts') }),
    ALLOWED,
  );
  assert.equal(exitCode({ file_path: '../oss/.worktrees/feat+x/packages/core/src/a.ts' }), ALLOWED);
});

test('a worktree path cannot climb back into the main checkout or reach node_modules', () => {
  assert.equal(
    exitCode({ file_path: '../oss/.worktrees/feat+x/../../packages/core/src/a.ts' }),
    DENIED,
  );
  assert.equal(
    exitCode({ file_path: join(oss, '.worktrees/feat+x/node_modules/pkg/index.js') }),
    DENIED,
  );
  assert.equal(
    exitCode({ command: 'sed -i s/a/b/ ../oss/.worktrees/feat+x/../../packages/a.ts' }),
    DENIED,
  );
});

test('shell writes are judged per path: worktree allowed, main checkout denied', () => {
  assert.equal(
    exitCode({ command: `sed -i s/a/b/ ${join(oss, '.worktrees/feat+x/a.ts')}` }),
    ALLOWED,
  );
  assert.equal(exitCode({ command: 'echo x > ../oss/.worktrees/feat+x/a.ts' }), ALLOWED);
  assert.equal(exitCode({ command: `sed -i s/a/b/ ${join(oss, 'packages/a.ts')}` }), DENIED);
  assert.equal(exitCode({ command: 'cp a b && rm -rf ../oss/packages' }), DENIED);
  assert.equal(
    exitCode({ command: 'echo x > ../oss/.worktrees/feat+x/a.ts; rm ../oss/a.ts' }),
    DENIED,
  );
});

test('copies, links, patches, and git writes into the main checkout are denied', () => {
  for (const command of [
    'cp overlay/a.ts ../oss/packages/core/src/a.ts',
    `cp -r overlay ${join(oss, 'packages')} 2>&1`,
    'install -m 644 a.ts ../oss/packages/a.ts',
    'ln -s ../oss/packages/core/src core-src',
    'patch ../oss/packages/a.ts fix.diff',
    'git -C ../oss apply fix.diff',
    'git -C ../oss checkout .',
  ]) {
    assert.equal(exitCode({ command }), DENIED, command);
  }
});

test('copies out of the checkout or into a worktree, and git reads, pass', () => {
  for (const command of [
    'cp ../oss/packages/core/src/a.ts overlay/a.ts',
    'cp overlay/a.ts ../oss/.worktrees/feat+x/a.ts',
    'git -C ../oss log --oneline',
    'git -C ../oss/.worktrees/feat+x checkout .',
    'grep -ln x ../oss/packages',
  ]) {
    assert.equal(exitCode({ command }), ALLOWED, command);
  }
});

test('a symlink into the checkout does not make a core path look local', () => {
  mkdirSync(join(oss, 'packages'));
  symlinkSync(join(oss, 'packages'), join(consumer, 'core-src'));
  assert.equal(exitCode({ file_path: join(consumer, 'core-src/core/src/a.ts') }), DENIED);
  assert.equal(exitCode({ file_path: 'core-src/a.ts' }), DENIED);
});

test('reads and consumer-local writes pass', () => {
  assert.equal(exitCode({ command: 'cat ../oss/packages/core/src/a.ts' }), ALLOWED);
  assert.equal(exitCode({ file_path: join(consumer, 'apps/api/src/a.ts') }), ALLOWED);
  assert.equal(exitCode({ file_path: join(consumer, 'node_modules/pkg/index.js') }), DENIED);
});

// node --test tools/__tests__/agent-retro-scan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCAN = join(
  import.meta.dirname,
  '../templates/consumer/__dot__rulesync/skills/agent-retro/scan.mjs',
);

const now = new Date().toISOString();
const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
const toolUse = (id, command, timestamp = now) => ({
  type: 'assistant',
  timestamp,
  message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
});
const toolError = (id, text, timestamp = now) => ({
  type: 'user',
  timestamp,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] },
});
const said = (text, extra = {}) => ({
  type: 'user',
  timestamp: now,
  message: { content: text },
  ...extra,
});

test('counts in-window failures, hook blocks and real corrections only', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-retro-'));
  const dir = join(root, '-Users-x-openora');
  mkdirSync(dir);
  const lines = [
    toolUse('old', 'pnpm verify', old),
    toolError('old', 'Exit code 1\nancient failure', old),
    toolUse('a', 'cd /x && pnpm verify'),
    toolError('a', 'Exit code 1\nlint failed'),
    toolUse('b', 'git push'),
    toolError('b', 'PreToolUse:Bash hook error: no review'),
    said('no, use the other branch'),
    said('This session is being continued from a previous conversation. no', {
      isCompactSummary: true,
    }),
  ];
  // one assistant message split into two content blocks repeats its usage
  const usage = { input_tokens: 400_000, output_tokens: 100_000 };
  lines.push(
    { type: 'assistant', timestamp: now, message: { id: 'm1', usage, content: [] } },
    { type: 'assistant', timestamp: now, message: { id: 'm1', usage, content: [] } },
    said('wciąż nie działa, token=abc123 from dev@example.com'),
  );
  const write = (path, entries) =>
    writeFileSync(path, entries.map((l) => JSON.stringify(l)).join('\n'));
  write(join(dir, 's1.jsonl'), lines);
  // a subagent of s1 failing the same way is the same incident, not a second session
  mkdirSync(join(dir, 's1', 'subagents'), { recursive: true });
  write(join(dir, 's1', 'subagents', 'agent-1.jsonl'), [
    toolUse('c', 'pnpm verify'),
    toolError('c', 'Exit code 1\nlint failed'),
  ]);
  writeFileSync(join(root, 'unrelated.jsonl'), '');

  const out = execFileSync('node', [SCAN, '--root', root, '--days', '7', '--save', 'false'], {
    encoding: 'utf8',
  });

  assert.match(out, /tool calls: 3, tool errors: 3, user corrections: 2/);
  assert.match(out, /tokens in window: 0\.5M/);
  assert.match(out, /\| 2 \| 1 \| Bash :: lint failed \|/);
  assert.match(out, /token=<redacted> from <email>/);
  assert.doesNotMatch(out, /abc123|dev@example\.com/);
  assert.match(out, /lint failed/);
  assert.doesNotMatch(out, /ancient failure/);
  assert.match(out, /no, use the other branch/);
  assert.doesNotMatch(out, /being continued/);
  // the hook block is an error, but not a failure of `git push` itself
  assert.doesNotMatch(out, /\| git push \(/);
  assert.match(out, /\| 1 \| 1 \| PreToolUse unnamed: no review \|/);
  assert.match(out, /\| 2 \| 1 \| pnpm verify \|/);
});

test('rejects a non-numeric --days', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-retro-'));
  assert.throws(
    () =>
      execFileSync('node', [SCAN, '--root', root, '--save', 'false', '--days', 'abc'], {
        stdio: 'pipe',
      }),
    (error) => /--days must be a positive integer/.test(String(error.stderr)),
  );
});

test('defaults to the transcripts of this checkout and openora, keyed checkout-relative', () => {
  const repo = join(mkdtempSync(join(tmpdir(), 'agent-retro-')), 'my.casino');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const root = mkdtempSync(join(tmpdir(), 'agent-retro-'));
  const read = (id, path) => ({
    type: 'assistant',
    timestamp: now,
    message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] },
  });
  const projects = {
    // the same file read from the main checkout and from a worktree is one row
    '-Users-x-my-casino': read('a', '/Users/x/my.casino/apps/api/src/index.ts'),
    '-Users-x-my-casino--claude-worktrees-fix': read(
      'b',
      '/Users/x/my.casino/.claude/worktrees/fix/apps/api/src/index.ts',
    ),
    '-Users-x-openora': read('c', '/Users/x/openora/README.md'),
    // a name that merely contains this repo's name is another project
    '-Users-x-my-casino2': read('d', '/Users/x/my-casino2/other.ts'),
  };
  for (const [dir, entry] of Object.entries(projects)) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, `${entry.message.content[0].id}.jsonl`), JSON.stringify(entry));
  }
  const out = execFileSync('node', [SCAN, '--root', root, '--save', 'false'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.match(out, /Main sessions: 3, subagent transcripts: 0, tool calls: 3/);
  assert.match(out, /\| 2 \| 2 \| apps\/api\/src\/index\.ts \|/);
  assert.match(out, /\| 1 \| 1 \| README\.md \|/);
  assert.doesNotMatch(out, /other\.ts/);
});

test('masks credentials in command examples', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-retro-'));
  const dir = join(root, '-Users-x-openora');
  mkdirSync(dir);
  const commands = [
    'curl -H "Authorization: Bearer sekret1aaaaaa" https://x',
    `echo '{"apiKey": "sekret2"}'`,
    'FIREBLOCKS_API_KEY: sekret3 node x',
    'psql postgres://u:sekret4@host/db',
    'mysql --password sekret5',
    'curl -H "Cookie: session=sekret6; csrf=sekret7" https://x',
    "curl -H 'Set-Cookie: sid=sekret8' https://x",
    'curl -b "session=sekret9; csrf=sekret10" https://x',
    'curl --cookie sid=sekret11 https://x',
    "printf '-----BEGIN PRIVATE KEY-----\nsekret6\n-----END PRIVATE KEY-----'",
  ];
  writeFileSync(
    join(dir, 's.jsonl'),
    [
      ...commands.map((command, i) => toolUse(`t${i}`, command)),
      toolUse('e', 'gh auth status'),
      // a digit-bearing token in an error: normalize must not split it before masking
      toolError('e', 'bad credentials for ghp_a1B2c3D4e5F69z8y7x'),
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  );
  const out = execFileSync('node', [SCAN, '--root', root, '--save', 'false'], { encoding: 'utf8' });
  assert.match(out, /tool calls: 11/);
  assert.doesNotMatch(out, /sekret|9z8y7x/);
  // masking keeps the key that groups rows
  assert.match(out, /\| 3 \| 1 \| curl -H \|/);
});

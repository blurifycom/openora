// Runs the real catalog generator against a throwaway repo root and checks the agent
// surface it reads from defineMcpTool / defineActionType literals.
// Run: node --test tools/__tests__/gen-catalog-agent-surface.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '../gen/gen-catalog.ts');

function generate(files) {
  const root = mkdtempSync(join(tmpdir(), 'gen-catalog-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    const result = spawnSync('pnpm', ['exec', 'tsx', script, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return {
      catalog: JSON.parse(readFileSync(join(root, 'docs', 'catalog.json'), 'utf8')),
      stderr: result.stderr,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const moduleFiles = {
  'packages/core/src/demo/index.ts': 'export {};\n',
  'packages/core/src/demo/plugin.ts': 'export default {};\n',
  'packages/core/src/demo/contract/agent-tools.ts': `
export const lookup = defineMcpTool({
  // a leading comment must not hide the key
  id: 'demo.lookup',
  title: 'Demo lookup',
  description: 'Reads one demo record, ' + "nothing else.",
  class: 'read',
  schemaVersion: 2,
  iam: { resource: 'player', action: 'view' },
  inputSchema: z.object({ code: z.string().regex(/^[^}]{1,8}$/), note: z.string().max(5) }),
  outputSchema: z.object({ id: z.string() }),
  redact: { allow: ['id'] },
  errors: ['demo_missing'],
});

export const apply = defineActionType({
  id: 'demo_apply',
  title: \`Apply demo\`,
  description: 'Applies it, idempotently.',
  schemaVersion: 1,
  iam: { resource: 'tag', action: 'create' },
  reversible: false,
  payloadSchema: z.object({ playerId: UuidSchema }).superRefine((v, ctx) => {
    if (/[{]/.test(String(v.playerId))) {
      ctx.addIssue({ code: 'custom', message: 'no braces' });
    }
  }),
  errors: [],
});

export const dynamic = defineMcpTool({ id: TOOL_ID, title: 'x' });
`,
  'packages/core/src/demo/__tests__/fake.test.ts': `
defineMcpTool({ id: 'test.only', title: 'ignored' });
`,
};

test('catalogues tool and action-type literals with their IAM and flags', () => {
  const { catalog } = generate(moduleFiles);
  assert.deepEqual(catalog.agentTools, [
    {
      id: 'demo.lookup',
      module: 'demo',
      file: 'packages/core/src/demo/contract/agent-tools.ts',
      title: 'Demo lookup',
      description: 'Reads one demo record, nothing else.',
      schemaVersion: 2,
      iam: { resource: 'player', action: 'view' },
      class: 'read',
    },
  ]);
  assert.deepEqual(catalog.agentActions, [
    {
      id: 'demo_apply',
      module: 'demo',
      file: 'packages/core/src/demo/contract/agent-tools.ts',
      title: 'Apply demo',
      description: 'Applies it, idempotently.',
      schemaVersion: 1,
      iam: { resource: 'tag', action: 'create' },
      reversible: false,
    },
  ]);
});

test('skips a definition whose id is not a literal, and says so', () => {
  const { catalog, stderr } = generate(moduleFiles);
  assert.equal(
    catalog.agentTools.some((t) => t.title === 'x'),
    false,
  );
  assert.match(stderr, /defineMcpTool\(\{\.\.\.\}\) without a literal id - skipped/);
});

const trickyFiles = {
  'packages/core/src/demo/index.ts': 'export {};\n',
  'packages/core/src/demo/plugin.ts': 'export default {};\n',
  'packages/core/src/demo/contract/agent-tools.ts': `
/**
 * Example for authors, not a registration: defineActionType({ id: 'doc_example', title: 'x' })
 */
// defineMcpTool({ id: 'line.comment', title: 'x' })
export const generic = defineMcpTool<typeof In, typeof Out>({
  id: 'demo.generic',
  title: 'Generic',
  description: 'Explicit type arguments.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'player', action: 'view' },
  inputSchema: z.object({
    code: z.string().max(8).refine((s) => /[}]/.test(s) === false),
    tag: z.string().max(8).refine((s) => {
      return /["}]/.test(s) === false;
    }),
  }),
  outputSchema: z.object({ id: z.string() }),
  redact: { allow: ['id'] },
  errors: [],
});

export const after = defineActionType({
  id: 'demo_after',
  title: 'After',
  description: 'Parsed after the tricky tool.',
  schemaVersion: 3,
  iam: { resource: 'tag', action: 'create' },
  reversible: true,
  payloadSchema: z.object({ playerId: UuidSchema }),
  errors: [],
});
`,
  'packages/core/src/demo/contract/broken.ts': `export const broken = defineMcpTool({ id: 'demo.broken', title: 'x',\n`,
};

test('ignores examples in comments and reads generic calls and literals holding regexes', () => {
  const { catalog, stderr } = generate(trickyFiles);
  assert.deepEqual(
    catalog.agentTools.map((t) => t.id),
    ['demo.generic'],
  );
  assert.deepEqual(
    catalog.agentActions.map((a) => [a.id, a.schemaVersion, a.reversible]),
    [['demo_after', 3, true]],
  );
  assert.match(stderr, /broken\.ts: defineMcpTool\(\{\.\.\.\}\) could not be parsed - skipped/);
});

test('an empty repo yields empty agent sections', () => {
  const { catalog } = generate({ 'README.md': '# empty\n' });
  assert.deepEqual(catalog.agentTools, []);
  assert.deepEqual(catalog.agentActions, []);
});

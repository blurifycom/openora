// Same harness style as oxlint-module-shape-plugin.test.mjs - calls create(context)
// directly, no oxlint binary. Run: node --test tools/__tests__/oxlint-boundaries-plugin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../lint/oxlint-boundaries-plugin.mjs';

function lint(ruleName, filename, run) {
  const reports = [];
  const context = { filename, report: (d) => reports.push(d.message) };
  const visitor = new Proxy(plugin.rules[ruleName].create(context), {
    get: (t, k) => t[k] ?? (() => {}),
  });
  run(visitor);
  return reports;
}

// Real oxlint filenames are absolute
const CORE = '/repo/packages/core/src';

function importNode(source) {
  return { source: { value: source } };
}

test('no-deep-dist-import flags a deep dist path', () => {
  const reports = lint('no-deep-dist-import', `${CORE}/wallet/service/wallet.service.ts`, (v) =>
    v.ImportDeclaration(importNode('@openora/core/dist/server/index.js')),
  );
  assert.equal(reports.length, 1);
});

test('no-deep-dist-import allows package subpath entries', () => {
  const reports = lint('no-deep-dist-import', `${CORE}/wallet/service/wallet.service.ts`, (v) =>
    v.ImportDeclaration(importNode('@openora/core/wallet/schema')),
  );
  assert.deepEqual(reports, []);
});

test('boundaries rules cover re-export laundering', () => {
  const reports = lint('no-cross-core-domain', `${CORE}/wallet/index.ts`, (v) =>
    v.ExportAllDeclaration(importNode('@openora/core/casino/service')),
  );
  assert.equal(reports.length, 1);
});

test('no-module-contract-to-runtime blocks non-isomorphic imports in a module contract', () => {
  for (const spec of [
    '@openora/core/server',
    'drizzle-orm',
    '@openora/core/wallet/schema',
    '../schema/index.js',
    'node:crypto',
  ]) {
    const reports = lint('no-module-contract-to-runtime', `${CORE}/wallet/contract/index.ts`, (v) =>
      v.ImportDeclaration(importNode(spec)),
    );
    assert.equal(reports.length, 1, spec);
  }
});

test('no-module-contract-to-runtime allows zod + core contracts, and ignores the engine contracts zone', () => {
  for (const spec of ['zod', '@openora/core/contracts']) {
    const ok = lint(
      'no-module-contract-to-runtime',
      `${CORE}/casino/gaming/contract/index.ts`,
      (v) => v.ImportDeclaration(importNode(spec)),
    );
    assert.deepEqual(ok, [], spec);
  }
  // the engine contracts/ zone is out of scope (covered by no-contracts-to-runtime instead)
  const engine = plugin.rules['no-module-contract-to-runtime'].create({
    filename: `${CORE}/contracts/schemas/wallet.ts`,
  });
  assert.deepEqual(Object.keys(engine), []);
});

test('no-cross-core-domain flags sibling internals, allows /schema + self', () => {
  const file = `${CORE}/engagement/chat/service/chat.service.ts`;
  const bad = lint('no-cross-core-domain', file, (v) =>
    v.ImportDeclaration(importNode('@openora/core/wallet/service')),
  );
  assert.equal(bad.length, 1);
  for (const spec of ['@openora/core/wallet/schema', '@openora/core/engagement/contracts']) {
    const ok = lint('no-cross-core-domain', file, (v) => v.ImportDeclaration(importNode(spec)));
    assert.deepEqual(ok, [], spec);
  }
});

test('no-engine-to-domain flags a domain import from the engine', () => {
  const reports = lint('no-engine-to-domain', `${CORE}/server/runtime/create-app.ts`, (v) =>
    v.ImportDeclaration(importNode('@openora/core/wallet/plugins')),
  );
  assert.equal(reports.length, 1);
});

test('out-of-scope files register no visitors', () => {
  for (const rule of ['no-cross-core-domain', 'no-react-to-runtime']) {
    const visitor = plugin.rules[rule].create({
      filename: '/repo/apps/mcp-server-dev/src/main.ts',
    });
    assert.deepEqual(Object.keys(visitor), [], rule);
  }
});

test('no-adhoc-zod-in-router covers core module routers', () => {
  const zCall = {
    callee: {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'z' },
      property: { type: 'Identifier', name: 'object' },
    },
  };
  const core = lint('no-adhoc-zod-in-router', `${CORE}/wallet/router/index.ts`, (v) =>
    v.CallExpression(zCall),
  );
  assert.equal(core.length, 1);
  const nested = lint('no-adhoc-zod-in-router', `${CORE}/engagement/chat/router/index.ts`, (v) =>
    v.CallExpression(zCall),
  );
  assert.equal(nested.length, 1);
});

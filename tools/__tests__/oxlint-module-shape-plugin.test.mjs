// Calls the plugin's rule `create(context)` functions directly (no oxlint binary
// dependency) - same "no tests exist yet for the boundaries plugin, add one small
// node test file" mandate, but exercising the actual rule logic instead of a fixture.
// Run: node --test tools/__tests__/oxlint-module-shape-plugin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../lint/oxlint-module-shape-plugin.mjs';

function lint(ruleName, filename, run) {
  const reports = [];
  const context = { filename, report: (d) => reports.push(d.message) };
  // create() returns {} for out-of-scope files - treat missing handlers as no-ops
  const visitor = new Proxy(plugin.rules[ruleName].create(context), {
    get: (t, k) => t[k] ?? (() => {}),
  });
  run(visitor);
  return reports;
}

const REPO = 'packages/core/src';

test('module-file-placement allows sanctioned domain-root files', () => {
  const reports = lint('module-file-placement', `${REPO}/wallet/index.ts`, (v) => v.Program({}));
  assert.deepEqual(reports, []);
});

test('module-file-placement rejects a stray domain-root file', () => {
  const reports = lint('module-file-placement', `${REPO}/wallet/random.ts`, (v) => v.Program({}));
  assert.equal(reports.length, 1);
});

test('module-file-placement allows files inside a canonical layer at any depth', () => {
  const reports = lint(
    'module-file-placement',
    `${REPO}/casino/gaming/adapters/mock/mock-game-adapter.ts`,
    (v) => v.Program({}),
  );
  assert.deepEqual(reports, []);
});

test('module-file-placement allows a multi-slice module root file', () => {
  const reports = lint('module-file-placement', `${REPO}/casino/gaming/plugin.ts`, (v) =>
    v.Program({}),
  );
  assert.deepEqual(reports, []);
});

test('module-file-placement rejects the removed schemas/ layer dir', () => {
  const reports = lint('module-file-placement', `${REPO}/wallet/schemas/helpers.ts`, (v) =>
    v.Program({}),
  );
  assert.equal(reports.length, 1);
});

test('module-file-placement rejects an unknown module-level subdir', () => {
  const reports = lint('module-file-placement', `${REPO}/casino/gaming/unknown-dir/stray.ts`, (v) =>
    v.Program({}),
  );
  assert.equal(reports.length, 1);
});

test('module-file-placement skips engine zones and common/testing', () => {
  for (const f of [
    `${REPO}/server/kernel/whatever.ts`,
    `${REPO}/common/errors/errors.base.ts`,
    `${REPO}/testing/mock.ts`,
  ]) {
    const reports = lint('module-file-placement', f, (v) => v.Program({}));
    assert.deepEqual(reports, [], f);
  }
});

test('layer-file-naming enforces .service.ts in service/', () => {
  const good = lint('layer-file-naming', `${REPO}/wallet/service/wallet.service.ts`, (v) =>
    v.Program({}),
  );
  assert.deepEqual(good, []);
  const bad = lint('layer-file-naming', `${REPO}/wallet/service/wallet-helpers.ts`, (v) =>
    v.Program({}),
  );
  assert.equal(bad.length, 1);
});

test('layer-file-naming allows the surveyed service/ exceptions', () => {
  const reports = lint('layer-file-naming', `${REPO}/compliance/service/re-kyc-trigger.ts`, (v) =>
    v.Program({}),
  );
  assert.deepEqual(reports, []);
});

test('layer-file-naming enforces .test.ts in __tests__/', () => {
  const good = lint('layer-file-naming', `${REPO}/wallet/__tests__/wallet.test.ts`, (v) =>
    v.Program({}),
  );
  assert.deepEqual(good, []);
  const bad = lint('layer-file-naming', `${REPO}/wallet/__tests__/wallet.spec.ts`, (v) =>
    v.Program({}),
  );
  assert.equal(bad.length, 1);
});

function importNode(source) {
  return { source: { value: source } };
}

test('no-relative-zone-escape flags a relative import escaping an engine zone', () => {
  const reports = lint('no-relative-zone-escape', `${REPO}/wallet/schema/index.ts`, (v) =>
    v.ImportDeclaration(importNode('../../contracts/schemas/wallet-tx.js')),
  );
  assert.equal(reports.length, 1);
});

test('no-relative-zone-escape flags a slice importing a sibling slice', () => {
  const reports = lint(
    'no-relative-zone-escape',
    `${REPO}/pam/player-management/service/player.service.ts`,
    (v) => v.ImportDeclaration(importNode('../../profile/schema/index.js')),
  );
  assert.equal(reports.length, 1);
});

test('no-relative-zone-escape flags a bare sibling-slice directory barrel', () => {
  const reports = lint(
    'no-relative-zone-escape',
    `${REPO}/casino/gaming/service/game.service.ts`,
    (v) => v.ImportDeclaration(importNode('../../lobby')),
  );
  assert.equal(reports.length, 1);
});

test('no-relative-zone-escape allows a slice reaching a domain-root file (server.js)', () => {
  const reports = lint(
    'no-relative-zone-escape',
    `${REPO}/pam/profile/service/profile.service.ts`,
    (v) => v.ImportDeclaration(importNode('../../server.js')),
  );
  assert.deepEqual(reports, []);
});

test('no-relative-zone-escape allows an in-module relative import', () => {
  const reports = lint('no-relative-zone-escape', `${REPO}/wallet/service/wallet.service.ts`, (v) =>
    v.ImportDeclaration(importNode('../schema/index.js')),
  );
  assert.deepEqual(reports, []);
});

test('no-relative-zone-escape allows a slice reaching a domain-root shared dir', () => {
  const reports = lint(
    'no-relative-zone-escape',
    `${REPO}/pam/profile/service/profile.service.ts`,
    (v) => v.ImportDeclaration(importNode('../../shared/player-mapper.js')),
  );
  assert.deepEqual(reports, []);
});

test('no-relative-zone-escape allows a domain-root composition file reaching its own slices', () => {
  const reports = lint('no-relative-zone-escape', `${REPO}/casino/index.ts`, (v) =>
    v.ExportAllDeclaration(importNode('./gaming/contract/index.js')),
  );
  assert.deepEqual(reports, []);
});

test('no-relative-zone-escape flags an engine-zone file reaching another zone', () => {
  const reports = lint('no-relative-zone-escape', `${REPO}/server/kernel/container.ts`, (v) =>
    v.ImportDeclaration(importNode('../../contracts/schemas/common.js')),
  );
  assert.equal(reports.length, 1);
});

test('no-relative-zone-escape allows an intra-engine-zone relative import', () => {
  const reports = lint('no-relative-zone-escape', `${REPO}/server/kernel/container.ts`, (v) =>
    v.ImportDeclaration(importNode('../db/drizzle.service.js')),
  );
  assert.deepEqual(reports, []);
});

test('no-relative-zone-escape still exempts scripts, common, and testing zones', () => {
  for (const f of [
    `${REPO}/scripts/gen.ts`,
    `${REPO}/common/errors/errors.base.ts`,
    `${REPO}/testing/mock.ts`,
  ]) {
    const reports = lint('no-relative-zone-escape', f, (v) =>
      v.ImportDeclaration(importNode('../../contracts/schemas/common.js')),
    );
    assert.deepEqual(reports, [], f);
  }
});

test('no-relative-zone-escape ignores non-relative (subpath) specifiers', () => {
  const reports = lint(
    'no-relative-zone-escape',
    `${REPO}/pam/player-management/service/player.service.ts`,
    (v) => v.ImportDeclaration(importNode('@blurifycom/core/pam/schema/profile')),
  );
  assert.deepEqual(reports, []);
});

function pgEnumCall(valuesArg) {
  return {
    callee: { type: 'Identifier', name: 'pgEnum' },
    arguments: [{ type: 'Literal', value: 'some_enum' }, valuesArg],
  };
}

test('no-inline-pg-enum allows a named tuple', () => {
  const reports = lint('no-inline-pg-enum', `${REPO}/wallet/schema/index.ts`, (v) =>
    v.CallExpression(pgEnumCall({ type: 'Identifier', name: 'WALLET_RAILS' })),
  );
  assert.deepEqual(reports, []);
});

test('no-inline-pg-enum rejects an inline array literal', () => {
  const reports = lint('no-inline-pg-enum', `${REPO}/wallet/schema/index.ts`, (v) =>
    v.CallExpression(pgEnumCall({ type: 'ArrayExpression', elements: [] })),
  );
  assert.equal(reports.length, 1);
});

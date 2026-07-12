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
    (v) => v.ImportDeclaration(importNode('@openora/core/pam/schema/profile')),
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

function importSpecifierNode(source, localName) {
  return {
    source: { value: source },
    specifiers: [{ type: 'ImportSpecifier', local: { type: 'Identifier', name: localName } }],
  };
}

function zInferTypeReference(schemaName) {
  return {
    typeName: {
      type: 'TSQualifiedName',
      left: { type: 'Identifier', name: 'z' },
      right: { type: 'Identifier', name: 'infer' },
    },
    typeArguments: {
      params: [{ type: 'TSTypeQuery', exprName: { type: 'Identifier', name: schemaName } }],
    },
  };
}

test('no-reinfer-imported-schema flags z.infer of a schema imported from a contract path', () => {
  const reports = lint(
    'no-reinfer-imported-schema',
    `${REPO}/pam/profile/react/profile.ts`,
    (v) => {
      v.ImportDeclaration(importSpecifierNode('@openora/core/contracts', 'PlayerSchema'));
      v.TSTypeReference(zInferTypeReference('PlayerSchema'));
    },
  );
  assert.equal(reports.length, 1);
});

test('no-reinfer-imported-schema allows z.infer of a locally-declared schema', () => {
  const reports = lint(
    'no-reinfer-imported-schema',
    `${REPO}/pam/profile/react/profile.ts`,
    (v) => {
      v.ImportDeclaration(importSpecifierNode('@openora/core/contracts', 'PlayerSchema'));
      v.TSTypeReference(zInferTypeReference('DerivedSchema'));
    },
  );
  assert.deepEqual(reports, []);
});

test('no-reinfer-imported-schema ignores an import from a non-contract path', () => {
  const reports = lint(
    'no-reinfer-imported-schema',
    `${REPO}/pam/profile/react/profile.ts`,
    (v) => {
      v.ImportDeclaration(importSpecifierNode('drizzle-orm', 'sql'));
      v.TSTypeReference(zInferTypeReference('sql'));
    },
  );
  assert.deepEqual(reports, []);
});

test('no-reinfer-imported-schema is out of scope inside a contract/schemas dir', () => {
  for (const f of [`${REPO}/wallet/contract/index.ts`, `${REPO}/contracts/schemas/common.ts`]) {
    const visitor = plugin.rules['no-reinfer-imported-schema'].create({ filename: f });
    assert.deepEqual(Object.keys(visitor), [], f);
  }
});

function stringIdParam(name) {
  return {
    type: 'Identifier',
    name,
    typeAnnotation: { typeAnnotation: { type: 'TSStringKeyword' } },
  };
}

function ownedIdParam(name) {
  return {
    type: 'Identifier',
    name,
    typeAnnotation: { typeAnnotation: { type: 'TSIndexedAccessType' } },
  };
}

function objectIdParam(propName, propType) {
  return {
    type: 'ObjectPattern',
    typeAnnotation: {
      typeAnnotation: {
        type: 'TSTypeLiteral',
        members: [
          {
            type: 'TSPropertySignature',
            key: { type: 'Identifier', name: propName },
            typeAnnotation: { typeAnnotation: { type: propType } },
          },
        ],
      },
    },
  };
}

test('no-bare-string-id-param flags a bare string Id param in a service file', () => {
  const reports = lint('no-bare-string-id-param', `${REPO}/iam/service/iam.service.ts`, (v) =>
    v.FunctionDeclaration({ params: [stringIdParam('roleId')] }),
  );
  assert.equal(reports.length, 1);
});

test('no-bare-string-id-param allows an id typed through the owning type', () => {
  const reports = lint('no-bare-string-id-param', `${REPO}/iam/service/iam.service.ts`, (v) =>
    v.FunctionDeclaration({ params: [ownedIdParam('roleId')] }),
  );
  assert.deepEqual(reports, []);
});

test('no-bare-string-id-param flags a bare string Id inside an inline object param', () => {
  const reports = lint('no-bare-string-id-param', `${REPO}/wallet/service/wallet.service.ts`, (v) =>
    v.FunctionExpression({
      params: [objectIdParam('withdrawalId', 'TSStringKeyword')],
    }),
  );
  assert.equal(reports.length, 1);
});

test('no-bare-string-id-param allows an object param id typed through the owning type', () => {
  const reports = lint('no-bare-string-id-param', `${REPO}/wallet/service/wallet.service.ts`, (v) =>
    v.ArrowFunctionExpression({
      params: [objectIdParam('withdrawalId', 'TSIndexedAccessType')],
    }),
  );
  assert.deepEqual(reports, []);
});

test('no-bare-string-id-param exempts the surveyed genuinely-external id names', () => {
  const reports = lint(
    'no-bare-string-id-param',
    `${REPO}/compliance/service/kyc.service.ts`,
    (v) => v.FunctionDeclaration({ params: [stringIdParam('referenceId')] }),
  );
  assert.deepEqual(reports, []);
});

test('no-bare-string-id-param ignores a param not ending in Id', () => {
  const reports = lint('no-bare-string-id-param', `${REPO}/iam/service/iam.service.ts`, (v) =>
    v.FunctionDeclaration({ params: [stringIdParam('name')] }),
  );
  assert.deepEqual(reports, []);
});

test('no-bare-string-id-param is out of scope outside service/router files', () => {
  const visitor = plugin.rules['no-bare-string-id-param'].create({
    filename: `${REPO}/wallet/schema/index.ts`,
  });
  assert.deepEqual(Object.keys(visitor), []);
});

function promiseAllOverMap({ promiseMethod = 'all', mapMethod = 'map', receiverType }) {
  return {
    callee: {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'Promise' },
      property: { type: 'Identifier', name: promiseMethod },
    },
    arguments: [
      {
        type: 'CallExpression',
        callee: {
          type: 'MemberExpression',
          object: { type: receiverType },
          property: { type: 'Identifier', name: mapMethod },
        },
      },
    ],
  };
}

test('no-unbounded-db-fanout flags Promise.all over a mapped query result', () => {
  const reports = lint('no-unbounded-db-fanout', `${REPO}/compliance/service/rg.service.ts`, (v) =>
    v.CallExpression(promiseAllOverMap({ receiverType: 'Identifier' })),
  );
  assert.equal(reports.length, 1);
});

test('no-unbounded-db-fanout also flags allSettled and flatMap', () => {
  const reports = lint('no-unbounded-db-fanout', `${REPO}/iam/service/iam.service.ts`, (v) =>
    v.CallExpression(
      promiseAllOverMap({
        promiseMethod: 'allSettled',
        mapMethod: 'flatMap',
        receiverType: 'Identifier',
      }),
    ),
  );
  assert.equal(reports.length, 1);
});

test('no-unbounded-db-fanout allows a fixed array-literal fan-out', () => {
  const reports = lint('no-unbounded-db-fanout', `${REPO}/iam/service/iam.service.ts`, (v) =>
    v.CallExpression(promiseAllOverMap({ receiverType: 'ArrayExpression' })),
  );
  assert.deepEqual(reports, []);
});

test('no-unbounded-db-fanout is out of scope outside service/router files', () => {
  const visitor = plugin.rules['no-unbounded-db-fanout'].create({
    filename: `${REPO}/wallet/schema/index.ts`,
  });
  assert.deepEqual(Object.keys(visitor), []);
});

const SCHEMA = `${REPO}/wallet/schema/index.ts`;
const SERVICE = `${REPO}/wallet/service/wallet.service.ts`;

const identCall = (name, args = []) => ({ callee: { type: 'Identifier', name }, arguments: args });
const str = (value) => ({ type: 'Literal', value });
const zMemberCall = (prop, args = []) => ({
  callee: {
    type: 'MemberExpression',
    object: { type: 'Identifier', name: 'z' },
    property: { type: 'Identifier', name: prop },
  },
  arguments: args,
});

test('no-naive-timestamp flags a bare timestamp() in a schema file', () => {
  const reports = lint('no-naive-timestamp', SCHEMA, (v) =>
    v.CallExpression(identCall('timestamp')),
  );
  assert.equal(reports.length, 1);
});

test('no-naive-timestamp allows timestamp({ withTimezone: true })', () => {
  const arg = {
    type: 'ObjectExpression',
    properties: [
      {
        type: 'Property',
        key: { type: 'Identifier', name: 'withTimezone' },
        value: { type: 'Literal', value: true },
      },
    ],
  };
  const reports = lint('no-naive-timestamp', SCHEMA, (v) =>
    v.CallExpression(identCall('timestamp', [arg])),
  );
  assert.deepEqual(reports, []);
});

test('no-naive-timestamp is out of scope outside schema files', () => {
  const visitor = plugin.rules['no-naive-timestamp'].create({ filename: SERVICE });
  assert.deepEqual(Object.keys(visitor), []);
});

test('no-float-money flags real() in a schema file', () => {
  const reports = lint('no-float-money', SCHEMA, (v) => v.CallExpression(identCall('real')));
  assert.equal(reports.length, 1);
});

test('no-float-money allows decimal()', () => {
  const reports = lint('no-float-money', SCHEMA, (v) => v.CallExpression(identCall('decimal')));
  assert.deepEqual(reports, []);
});

test('drizzle-snake-case flags a PascalCase pgTable name', () => {
  const reports = lint('drizzle-snake-case', SCHEMA, (v) =>
    v.CallExpression(identCall('pgTable', [str('WalletTransaction')])),
  );
  assert.equal(reports.length, 1);
});

test('drizzle-snake-case flags a camelCase explicit column name', () => {
  const reports = lint('drizzle-snake-case', SCHEMA, (v) =>
    v.CallExpression(identCall('uuid', [str('walletId')])),
  );
  assert.equal(reports.length, 1);
});

test('drizzle-snake-case allows a snake_case name and a name-less column', () => {
  const ok = lint('drizzle-snake-case', SCHEMA, (v) => {
    v.CallExpression(identCall('pgTable', [str('wallet_transaction')]));
    v.CallExpression(identCall('uuid', []));
    v.CallExpression(identCall('index', [str('wallet_transaction_wallet_id_idx')]));
  });
  assert.deepEqual(ok, []);
});

test('no-raw-z-uuid flags z.uuid() outside the definition file', () => {
  const reports = lint('no-raw-z-uuid', `${REPO}/wallet/contract/index.ts`, (v) =>
    v.CallExpression(zMemberCall('uuid')),
  );
  assert.equal(reports.length, 1);
});

test('no-raw-z-uuid exempts the UuidSchema definition file', () => {
  const visitor = plugin.rules['no-raw-z-uuid'].create({
    filename: `${REPO}/contracts/schemas/common.ts`,
  });
  assert.deepEqual(Object.keys(visitor), []);
});

test('no-inline-z-enum-outside-contract flags z.enum([...]) in a service', () => {
  const reports = lint('no-inline-z-enum-outside-contract', SERVICE, (v) =>
    v.CallExpression(zMemberCall('enum', [{ type: 'ArrayExpression', elements: [] }])),
  );
  assert.equal(reports.length, 1);
});

test('no-inline-z-enum-outside-contract allows z.enum(TUPLE) and is out of scope in contract dirs', () => {
  const allowed = lint('no-inline-z-enum-outside-contract', SERVICE, (v) =>
    v.CallExpression(zMemberCall('enum', [{ type: 'Identifier', name: 'WALLET_STATUSES' }])),
  );
  assert.deepEqual(allowed, []);
  const visitor = plugin.rules['no-inline-z-enum-outside-contract'].create({
    filename: `${REPO}/wallet/contract/index.ts`,
  });
  assert.deepEqual(Object.keys(visitor), []);
});

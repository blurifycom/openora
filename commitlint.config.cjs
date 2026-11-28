const { readdirSync } = require('node:fs');

const dirsIn = (rel) => {
  try {
    return readdirSync(`${__dirname}/${rel}`, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const layerDirs = new Set([
  '__tests__',
  'adapters',
  'contract',
  'contracts',
  'drizzle',
  'migrations',
  'plugin',
  'react',
  'router',
  'schema',
  'schemas',
  'seed',
  'service',
]);

const nestedDirsIn = (rel) =>
  dirsIn(rel).flatMap((top) => dirsIn(`${rel}/${top}`).filter((sub) => !layerDirs.has(sub)));

const metaScopes = [
  'agents',
  'ci',
  'clean-architecture',
  'conventions',
  'deps',
  'hooks',
  'release',
  'repo',
  'rules',
  'scaffold',
  'tooling',
  'tsconfig',
];

const scopes = [
  ...new Set([
    ...dirsIn('packages'),
    ...dirsIn('packages/core/src'),
    ...nestedDirsIn('packages/core/src'),
    ...dirsIn('apps'),
    ...metaScopes,
  ]),
].sort();

module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', scopes],
    'body-max-line-length': [0, 'always'],
  },
};

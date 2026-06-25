const { readdirSync } = require('node:fs');

// Derive scopes from the workspace layout so the list never drifts.
// Meta scopes that map to no directory are listed explicitly below.
const dirsIn = (rel) => {
  try {
    return readdirSync(`${__dirname}/${rel}`, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const metaScopes = [
  'agents',
  'ci',
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
    ...dirsIn('packages/addons'),
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

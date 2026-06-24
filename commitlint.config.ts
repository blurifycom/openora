import { readdirSync } from 'node:fs';

// Derive scopes from the workspace layout so the list never drifts: packages/*,
// packages/core/src/* (core domains + engine zones), packages/addons/*, apps/*.
// Meta scopes that map to no directory are listed explicitly below.
const root = import.meta.dirname;

const dirsIn = (rel: string) => {
  try {
    return readdirSync(`${root}/${rel}`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
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

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', scopes],
    'body-max-line-length': [0, 'always'],
  },
};

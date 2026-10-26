#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const repoRoot = join(packageRoot, '..', '..');
const outDir = join(packageRoot, 'src', 'generated');
const outFile = join(outDir, 'versions.ts');

const readPackageJson = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

// A scaffold pins the toolchain this repo builds with, so the template never carries its own copy.
function generateVersions() {
  const core = readPackageJson(join(repoRoot, 'packages', 'core'));
  const root = readPackageJson(repoRoot);
  const devVersion = (name) => {
    const version = root.devDependencies[name];
    if (!version) {
      throw new Error(`root package.json has no devDependency ${name}`);
    }
    return version;
  };
  const versions = {
    coreVersion: `^${core.version}`,
    packageManager: root.packageManager,
    tsxVersion: devVersion('tsx'),
    turboVersion: devVersion('turbo'),
    typescriptVersion: devVersion('typescript'),
    typesNodeVersion: devVersion('@types/node'),
    oxlintVersion: devVersion('oxlint'),
    rulesyncVersion: devVersion('rulesync'),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, `export const VERSIONS = ${JSON.stringify(versions, null, 2)};\n`);
}

generateVersions();

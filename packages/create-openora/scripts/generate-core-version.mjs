#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const corePackageJsonPath = join(packageRoot, '..', 'core', 'package.json');
const outDir = join(packageRoot, 'src', 'generated');
const outFile = join(outDir, 'core-version.ts');

function generateCoreVersion() {
  const corePackageJson = JSON.parse(readFileSync(corePackageJsonPath, 'utf8'));
  const coreVersion = `^${corePackageJson.version}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, `export const CORE_VERSION = ${JSON.stringify(coreVersion)};\n`);
}

generateCoreVersion();

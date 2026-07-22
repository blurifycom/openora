#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const sourceRoot = join(packageRoot, '..', '..', 'tools', 'templates', 'consumer');
const targetRoot = join(packageRoot, 'template');

function copyTemplate() {
  if (!existsSync(sourceRoot)) {
    throw new Error(`template source missing at ${sourceRoot}`);
  }
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  cpSync(sourceRoot, targetRoot, { recursive: true });
}

copyTemplate();

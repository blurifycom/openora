import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';
import integration from './vitest.integration.config';
import e2e from '../testing/vitest.config';

const CORE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const TESTING_ROOT = fileURLToPath(new URL('../testing/', import.meta.url));
const COMPILED_CORE_MODULE = /(?:packages\/core\/|^\.\/)dist\/(.+)\.js$/;

const { exports: coreExports } = JSON.parse(readFileSync(`${CORE_ROOT}package.json`, 'utf8')) as {
  exports: Record<string, { import?: string; default?: string }>;
};

function toInstrumentedSource(compiled: string | undefined): string | undefined {
  const module = compiled && COMPILED_CORE_MODULE.exec(compiled)?.[1];
  return module ? `${CORE_ROOT}src/${module}.ts` : undefined;
}

// The e2e tier reaches core through its package exports and the `dist` paths in
// `extensions.config.ts`. Stryker instruments `src`, so without this every e2e test would run
// against unmutated code and no mutant could ever die to one.
function resolveCoreToInstrumentedSource(): Plugin {
  return {
    name: 'resolve-core-to-instrumented-source',
    enforce: 'pre',
    resolveId(source) {
      if (!source.startsWith('@openora/core')) {
        return toInstrumentedSource(source);
      }
      const entry = coreExports[source.replace('@openora/core', '.')];
      return toInstrumentedSource(entry?.import ?? entry?.default);
    },
  };
}

// Stryker runs one vitest per mutant, so every tier goes into one config: a mutant only a unit
// test or only an e2e test catches counts as killed instead of survived. Each tier stays a
// project because each has its own root, setup files and global setup. Stryker pins the worker
// count itself, so the tiers' own `maxWorkers` is dropped.
const { maxWorkers: _coreWorkers, ...coreTest } = integration.test ?? {};
const { maxWorkers: _e2eWorkers, ...e2eTest } = e2e.test ?? {};
// One flaky failure in Stryker's initial run aborts the whole run, and one during a mutant run
// counts as a kill the mutant did not earn.
const RETRY = 2;
const SLOW_WAIT_SETUP = `${CORE_ROOT}vitest.mutation.setup.ts`;

export default defineConfig({
  test: {
    projects: [
      {
        ...integration,
        root: CORE_ROOT,
        test: {
          ...coreTest,
          name: 'core',
          include: ['src/**/*.{test,spec}.ts'],
          retry: RETRY,
          setupFiles: [SLOW_WAIT_SETUP, ...[coreTest.setupFiles ?? []].flat()],
        },
      },
      {
        ...e2e,
        root: TESTING_ROOT,
        plugins: [resolveCoreToInstrumentedSource()],
        test: {
          ...e2eTest,
          name: 'e2e',
          retry: RETRY,
          setupFiles: [SLOW_WAIT_SETUP, ...[e2eTest.setupFiles ?? []].flat()],
        },
      },
    ],
  },
});

// Architectural boundary enforcement. Runs in `pnpm verify` (the root `lint` script).
//
// Cross-package imports in this workspace are always `@oss/*` specifiers that
// resolve to dist/, so we enforce layering with eslint-plugin-boundaries'
// SPECIFIER-based `boundaries/external` rule (no import resolver needed) rather
// than file-path element-types. Every rule carries an agent-legible `message`
// that names the allowed alternative.
//
// Layering (see AGENTS.md > Dependency rules):
//   module      -> contracts, adapters, platform, ui, sdks, other modules' /schema (NOT another module's code)
//   platform    -> platform, contracts            (NOT modules, NOT ui)
//   runtime     -> anything (api-runtime is the composition root)
//   contracts   -> contracts only
//   extension   -> any @oss/* (NOT another extension)

import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const ELEMENTS = [
  // Order matters: most specific first. A module's /schema subpath is a
  // published data contract other modules may read; the rest of a module is not.
  { type: 'module-schema', mode: 'full', pattern: 'packages/modules/*/*/src/schema/**' },
  { type: 'module', mode: 'full', pattern: 'packages/modules/*/*/**', capture: ['group', 'name'] },
  { type: 'runtime', mode: 'full', pattern: 'packages/platform/api-runtime/**' },
  { type: 'platform', mode: 'full', pattern: 'packages/platform/*/**', capture: ['name'] },
  { type: 'contracts', mode: 'full', pattern: 'packages/contracts/*/**', capture: ['name'] },
  { type: 'sdks', mode: 'full', pattern: 'packages/sdks/*/**', capture: ['name'] },
  { type: 'ui', mode: 'full', pattern: 'packages/ui/*/**', capture: ['name'] },
  { type: 'extension', mode: 'full', pattern: 'apps/extensions/*/**', capture: ['name'] },
  { type: 'app', mode: 'full', pattern: 'apps/*/**' },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/storybook-static/**',
      '**/generated/**',
      '**/*.d.ts',
    ],
  },
  {
    files: ['packages/**/*.ts', 'packages/**/*.tsx', 'apps/**/*.ts', 'apps/**/*.tsx'],
    plugins: { boundaries },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: false },
    },
    settings: {
      'boundaries/elements': ELEMENTS,
      // @oss/* workspace packages resolve to dist (look "external"); governed by
      // specifier via the boundaries/dependencies rule below (checkAllOrigins).
      'boundaries/ignore': ['**/*.test.ts', '**/*.spec.ts'],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          // @oss/* workspace packages resolve to node_modules (external); check them too.
          checkAllOrigins: true,
          rules: [
            {
              from: [{ type: 'module' }],
              // bare `@oss/modules/<group>/<name>` is another module's code (micromatch
              // `*` does not cross `/`); `.../schema` has an extra segment and stays allowed.
              disallow: [{ dependency: { source: '@oss/modules/*/*' } }],
              message:
                "Modules must not import another module's code. Communicate via events (@Inject(EVENT_BUS)) or read its tables through the @oss/modules/<group>/<name>/schema subpath. See AGENTS.md > Dependency rules.",
            },
            {
              from: [{ type: 'platform' }],
              disallow: [{ dependency: { source: ['@oss/modules', '@oss/modules/**', '@oss/ui-*'] } }],
              message:
                'platform/* must not import feature modules or UI. Platform may import only other platform packages and @oss/contracts/*. (api-runtime is the composition root and is classified separately.) See AGENTS.md > Dependency rules.',
            },
            {
              from: [{ type: 'contracts' }],
              disallow: [
                {
                  dependency: {
                    source: [
                      '@oss/modules',
                      '@oss/modules/**',
                      '@oss/core',
                      '@oss/db',
                      '@oss/db/**',
                      '@oss/auth',
                      '@oss/plugin-host',
                      '@oss/api-runtime',
                      '@oss/sdk-core',
                      '@oss/react-sdk',
                      '@oss/ui-*',
                    ],
                  },
                },
              ],
              message:
                'contracts/* may import only other contracts and zod. See AGENTS.md > Dependency rules.',
            },
          ],
        },
      ],
      // Public-API enforcement: never reach into a package's built internals.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@oss/*/dist/**', '@oss/**/dist/**'],
              message:
                'Import the package entry (e.g. @oss/modules/player/wallet/schema), never a deep dist path.',
            },
          ],
        },
      ],
    },
  },
);

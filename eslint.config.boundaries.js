// Boundary linting using eslint-plugin-boundaries.
// Run: pnpm --filter=root eslint --config eslint.config.boundaries.js packages/
//
// Rules:
//   modules -> can import: platform, contracts, ui, sdks (NOT other modules)
//   platform -> can import: contracts (NOT modules, NOT ui)
//   contracts -> can import: nothing in @oss (only zod, etc.)
//   extensions -> can import: any @oss/* (NOT other extensions)

import boundaries from 'eslint-plugin-boundaries';

export default [
  {
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'module', pattern: 'packages/modules/*', capture: ['name'] },
        { type: 'platform', pattern: 'packages/platform/*', capture: ['name'] },
        { type: 'contracts', pattern: 'packages/contracts/*', capture: ['name'] },
        { type: 'sdks', pattern: 'packages/sdks/*', capture: ['name'] },
        { type: 'ui', pattern: 'packages/ui/*', capture: ['name'] },
        { type: 'extension', pattern: 'apps/extensions/*', capture: ['name'] },
        { type: 'app', pattern: 'apps/api' },
        { type: 'app', pattern: 'apps/backoffice' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            // modules: can import platform, contracts, ui, sdks
            { from: 'module', allow: ['platform', 'contracts', 'sdks', 'ui'] },
            // platform: can import contracts
            { from: 'platform', allow: ['contracts', 'platform'] },
            // contracts: nothing internal
            { from: 'contracts', allow: ['contracts'] },
            // sdks: can import contracts
            { from: 'sdks', allow: ['contracts', 'platform'] },
            // ui: can import contracts, ui
            { from: 'ui', allow: ['contracts', 'ui'] },
            // extensions: can import any @oss/* but not other extensions
            { from: 'extension', allow: ['module', 'platform', 'contracts', 'sdks', 'ui'] },
            // apps: unrestricted
            { from: 'app', allow: ['module', 'platform', 'contracts', 'sdks', 'ui', 'extension'] },
          ],
        },
      ],
    },
  },
];

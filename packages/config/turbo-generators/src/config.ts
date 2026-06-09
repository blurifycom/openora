import { dirname, join } from 'node:path';
import type { PlopTypes } from '@turbo/gen';

// Shared turbo gen generators for downstream igaming consumers. A consumer repo's
// `turbo/generators/config.ts` re-exports this default, so `pnpm gen <name>` works
// without each repo carrying its own copy:
//   export { default } from '@oss/turbo-generators';
//
//   pnpm gen plugin   - new overlay plugin under apps/api/src/extensions/
//   pnpm gen adapter  - overlay that rebinds a vendor adapter DI token

// turbo gen bundles this config into a CJS file inside the *consumer* repo, so
// import.meta.url / __dirname point at the consumer, not here, and the .hbs files are
// never copied. Resolve our own install dir through the consumer's node_modules (the
// bundle is CJS, so `require.resolve` is the real Node resolver) and read templates
// from there by absolute path.
declare const require: NodeJS.Require;
const pkgDir = dirname(require.resolve('@oss/turbo-generators/package.json'));
const tpl = (name: string): string => join(pkgDir, 'src', 'templates', name);

const kebabRe = /^[a-z][a-z0-9-]*$/;

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator('plugin', {
    description: 'New overlay plugin (routes / providers / event handlers)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Plugin name (kebab-case):',
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
    ],
    actions: [
      {
        type: 'add',
        path: 'apps/api/src/extensions/{{kebabCase name}}/plugin.ts',
        templateFile: tpl('plugin.hbs'),
      },
    ],
  });

  plop.setGenerator('adapter', {
    description: 'Overlay that swaps a vendor adapter (rebinds a DI token)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Adapter name (kebab-case, eg stripe-payment):',
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
      {
        type: 'list',
        name: 'token',
        message: 'Which adapter token does this override?',
        choices: ['PAYMENT_ADAPTER', 'KYC_ADAPTER', 'NOTIFICATION_DELIVERY_ADAPTER'],
      },
      {
        type: 'input',
        name: 'dependsOn',
        message: 'Load after which module? (the one that owns the default binding)',
        default: 'wallet',
      },
    ],
    actions: [
      {
        type: 'add',
        path: 'apps/api/src/extensions/{{kebabCase name}}/plugin.ts',
        templateFile: tpl('adapter.hbs'),
      },
    ],
  });
}

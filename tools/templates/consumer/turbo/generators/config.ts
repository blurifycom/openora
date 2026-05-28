import type { PlopTypes } from '@turbo/gen';

// turbo gen generators for this consumer repo. Run with `pnpm gen <name>`.
//   pnpm gen plugin    - new overlay plugin under apps/api/src/extensions/
//   pnpm gen adapter   - overlay that rebinds a vendor adapter DI token
//   pnpm gen page      - mount an @oss/react-sdk page on a route
export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator('plugin', {
    description: 'New overlay plugin (routes / providers / event handlers)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Plugin name (kebab-case):',
        validate: (v: string) => (/^[a-z][a-z0-9-]*$/.test(v) ? true : 'use kebab-case'),
      },
    ],
    actions: [
      {
        type: 'add',
        path: 'apps/api/src/extensions/{{kebabCase name}}/plugin.ts',
        templateFile: 'templates/plugin.hbs',
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
        validate: (v: string) => (/^[a-z][a-z0-9-]*$/.test(v) ? true : 'use kebab-case'),
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
        templateFile: 'templates/adapter.hbs',
      },
    ],
  });

  // FOLLOW-UP: this generator emits a Next App Router shim
  // (apps/<surface>/app/<route>/page.tsx). It is correct for the Next `web` app only.
  // The backoffice is a Vite + TanStack Router SPA and needs a `createFileRoute` module
  // under `src/routes/` instead - make this generator surface-aware (detect web vs
  // backoffice, pick the template) before relying on it for the backoffice.
  plop.setGenerator('page', {
    description: 'Mount an @oss/react-sdk page component on a route (Next variant)',
    prompts: [
      {
        type: 'list',
        name: 'surface',
        message: 'Which app?',
        choices: ['web', 'backoffice'],
      },
      {
        type: 'input',
        name: 'route',
        message: 'Route segment (eg promotions, players/vip):',
        validate: (v: string) => (/^[a-z0-9/-]+$/.test(v) ? true : 'lowercase path segments'),
      },
      {
        type: 'input',
        name: 'component',
        message: 'Exported @oss/react-sdk page component (eg DashboardPage):',
        validate: (v: string) => (/^[A-Z][A-Za-z0-9]+$/.test(v) ? true : 'PascalCase export name'),
      },
    ],
    actions: [
      {
        type: 'add',
        path: 'apps/{{surface}}/app/{{route}}/page.tsx',
        templateFile: 'templates/page.hbs',
      },
    ],
  });
}

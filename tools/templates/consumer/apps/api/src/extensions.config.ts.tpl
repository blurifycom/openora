import { corePlugins, type PluginEntry } from '@openora/core/server';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Your plugin registry. `corePlugins()` returns every built-in platform plugin,
// resolved from the installed @openora/core. Add your own overlays after it - a
// later registration of a DI token wins, so an adapter override must come after
// the module it replaces. Opt a core module out with a filter, eg
// `corePlugins().filter((p) => p.id !== 'chat')`.
//
// Every `path` must be absolute: the plugin host imports it from inside
// @openora/core, where a relative path or a bare package name resolves from
// core's location instead of this file's.

// Local overlays live alongside this file, under src/extensions/<name>/.
const LOCAL = resolve(dirname(fileURLToPath(import.meta.url)), 'extensions');

// Add-on packages installed from a registry resolve from this app.
const fromApp = createRequire(import.meta.url).resolve;

export const extensions: PluginEntry[] = [
  ...corePlugins(),

  // Your overlays. Generate with `pnpm gen plugin` / `pnpm gen adapter`.
  // Example (loaded after `wallet` so its PAYMENT_ADAPTER binding wins):
  // { id: 'my-payment', path: `${LOCAL}/my-payment/plugin.ts` },

  // An add-on package, after the modules it depends on:
  // { id: 'igaming-poker', path: fromApp('@acme/igaming-poker/plugin') },
];

void LOCAL;
void fromApp;

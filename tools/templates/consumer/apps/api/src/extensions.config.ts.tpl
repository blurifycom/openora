import type { PluginEntry } from '@blurifycom/plugin-host';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Your plugin registry. The plugin-host loads these top-to-bottom (respecting any
// `dependsOn`). Opt out of a module by deleting its entry; add your own overlays at
// the bottom. Adapter overrides MUST come after the module that owns the default
// binding - last registration of a DI token wins.
//
// Paths point at BUILT plugin dist inside the linked @blurifycom/modules, not source: tsx in
// this API entry can't reliably resolve the OSS tsconfig (decorator metadata drops).
// Run `pnpm build:oss` before booting. Local overlays under src/extensions/ are loaded
// from .ts source directly.

const here = dirname(fileURLToPath(import.meta.url));

// From apps/api/src to the linked OSS checkout's built modules.
const MODULES = resolve(here, '{{ossFromApiSrc}}/packages/modules/dist');

// Local overlays live alongside this file, under src/extensions/<name>/.
const LOCAL = resolve(here, 'extensions');

export const extensions: PluginEntry[] = [
  // Platform - shared substrate.
  { id: 'identity', path: `${MODULES}/platform/identity/src/plugin.js` },
  { id: 'notifications', path: `${MODULES}/platform/notifications/src/plugin.js` },
  { id: 'compliance', path: `${MODULES}/platform/compliance/src/plugin.js` },
  { id: 'localization', path: `${MODULES}/platform/localization/src/plugin.js` },

  // Player surface.
  { id: 'wallet', path: `${MODULES}/player/wallet/src/plugin.js` },
  { id: 'gaming', path: `${MODULES}/player/gaming/src/plugin.js` },
  { id: 'lobby', path: `${MODULES}/player/lobby/src/plugin.js` },
  { id: 'bonus', path: `${MODULES}/player/bonus/src/plugin.js` },

  // Backoffice surface.
  { id: 'admin-console', path: `${MODULES}/backoffice/admin-console/src/plugin.js` },
  { id: 'player-management', path: `${MODULES}/backoffice/player-management/src/plugin.js` },
  { id: 'cms', path: `${MODULES}/backoffice/cms/src/plugin.js` },

  // Your overlays. Generate with `pnpm gen plugin` / `pnpm gen adapter`.
  // Example (loaded after `wallet` so its PAYMENT_ADAPTER binding wins):
  // { id: 'my-payment', path: `${LOCAL}/my-payment/plugin.ts` },
];

void LOCAL;

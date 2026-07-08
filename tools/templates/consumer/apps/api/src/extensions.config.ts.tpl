import type { PluginEntry } from '@openora/core/server';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Your plugin registry. The plugin-host loads these top-to-bottom (respecting any
// `dependsOn`). Opt out of a module by deleting its entry; add your own overlays at
// the bottom. Adapter overrides MUST come after the module that owns the default
// binding - last registration of a DI token wins.
//
// Paths point at BUILT plugin dist inside the linked @openora/core, not source: tsx in
// this API entry can't reliably resolve the OSS tsconfig.
// Run `pnpm build:oss` before booting. Local overlays under src/extensions/ are loaded
// from .ts source directly.

const here = dirname(fileURLToPath(import.meta.url));

// From apps/api/src to the linked OSS checkout's built core.
const CORE = resolve(here, '{{ossFromApiSrc}}/packages/core/dist');

// Local overlays live alongside this file, under src/extensions/<name>/.
const LOCAL = resolve(here, 'extensions');

export const extensions: PluginEntry[] = [
  // Core add-ons (always loaded; contracts composed in main.ts).
  { id: 'audit', path: `${CORE}/audit/plugin.js` },
  { id: 'iam', path: `${CORE}/iam/plugin.js` },

  // Platform - shared substrate.
  { id: 'identity', path: `${CORE}/pam/identity/plugin.js` },
  { id: 'notifications', path: `${CORE}/engagement/notifications/plugin.js` },
  { id: 'compliance', path: `${CORE}/compliance/plugin.js` },

  // Player surface.
  { id: 'wallet', path: `${CORE}/wallet/plugin.js` },
  { id: 'gaming', path: `${CORE}/casino/gaming/plugin.js` },
  { id: 'lobby', path: `${CORE}/casino/lobby/plugin.js` },
  { id: 'chat', path: `${CORE}/engagement/chat/plugin.js` },
  { id: 'profile', path: `${CORE}/pam/profile/plugin.js` },

  // Backoffice surface.
  { id: 'admin-console', path: `${CORE}/admin-console/plugin.js` },
  { id: 'cms', path: `${CORE}/cms/plugin.js` },

  // Your overlays. Generate with `pnpm gen plugin` / `pnpm gen adapter`.
  // Example (loaded after `wallet` so its PAYMENT_ADAPTER binding wins):
  // { id: 'my-payment', path: `${LOCAL}/my-payment/plugin.ts` },
];

void LOCAL;

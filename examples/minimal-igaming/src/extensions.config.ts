import type { PluginEntry } from '@oss/plugin-host';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The consumer's own plugin registry. Same shape as the OSS root extensions.config.ts:
// an array of { id, path } that the plugin-host loads top-to-bottom (respecting any
// `dependsOn` a plugin declares). Opt out of a module by deleting its entry.
//
// IMPORTANT: paths point at BUILT plugin dist, not source. tsx in the consumer's API
// entry cannot reliably resolve the OSS tsconfig (decorator metadata gets dropped), so
// the registry references `@oss/modules`'s compiled output. Always build @oss/modules
// before boot (`pnpm build:oss`). See docs/downstream-consumer.md > Consumer load pattern.

const here = dirname(fileURLToPath(import.meta.url));

// This example assumes a sibling layout: the consumer repo lives next to igaming-oss.
// From this file (examples/minimal-igaming/src) the OSS modules dist is two levels up.
const OSS_MODULES = resolve(here, '../../igaming-oss/packages/modules/dist');

// Local overlays live alongside this config, under src/extensions/<name>/.
const LOCAL = resolve(here, 'extensions');

export const extensions: PluginEntry[] = [
  // Platform - shared substrate used by every surface.
  { id: 'identity', path: `${OSS_MODULES}/platform/identity/src/plugin.js` },
  { id: 'compliance', path: `${OSS_MODULES}/platform/compliance/src/plugin.js` },

  // Player - the player-facing igaming surface. `wallet` binds a default
  // PaymentAdapter; our overlay below rebinds it.
  { id: 'wallet', path: `${OSS_MODULES}/player/wallet/src/plugin.js` },
  { id: 'gaming', path: `${OSS_MODULES}/player/gaming/src/plugin.js` },
  { id: 'lobby', path: `${OSS_MODULES}/player/lobby/src/plugin.js` },

  // Backoffice - the admin/operator surface.
  { id: 'admin-console', path: `${OSS_MODULES}/backoffice/admin-console/src/plugin.js` },

  // Local overlay. Loaded AFTER `wallet` so its PAYMENT_ADAPTER binding wins
  // (last registration of a DI token wins). tsx loads this .ts source directly.
  { id: 'stripe-payment', path: `${LOCAL}/stripe-payment/plugin.ts` },
];

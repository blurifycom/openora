import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';
import { FIXTURE_LIMITS } from './limits-plugin.js';

/** How often this plugin registered, on globalThis: the host imports this file by path, not the test. */
export function countedRegistrations() {
  const holder = globalThis as { __countedRegistrations?: { count: number } };
  holder.__countedRegistrations ??= { count: 0 };
  return holder.__countedRegistrations;
}

export default {
  id: 'fixture-counted',
  controlPorts: [
    { port: FIXTURE_LIMITS, without: 'fixture limits go unenforced', boundBy: 'fixture-limits' },
  ],
  register() {
    countedRegistrations().count += 1;
  },
} satisfies Plugin<TokenCatalog>;

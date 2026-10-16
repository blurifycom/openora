import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';
import { FIXTURE_LIMITS } from './limits-plugin.js';

export default {
  id: 'fixture-limited',
  controlPorts: [
    { port: FIXTURE_LIMITS, without: 'fixture limits go unenforced', boundBy: 'fixture-limits' },
  ],
  register() {},
} satisfies Plugin<TokenCatalog>;

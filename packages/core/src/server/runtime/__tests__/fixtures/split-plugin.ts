import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';
import { FIXTURE_DISPATCH } from './dispatch-plugin.js';
import { FIXTURE_LIMITS } from './limits-plugin.js';

export default {
  id: 'fixture-split',
  dependsOn: ['fixture-feature'],
  requiresPorts: [FIXTURE_DISPATCH],
  controlPorts: [
    { port: FIXTURE_LIMITS, without: 'fixture limits go unenforced', boundBy: 'fixture-limits' },
  ],
  register() {},
} satisfies Plugin<TokenCatalog>;

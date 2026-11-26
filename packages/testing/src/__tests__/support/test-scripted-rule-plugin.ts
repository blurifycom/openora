import { randomUUID } from 'node:crypto';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { DRIZZLE } from '@openora/core/server';
import {
  ADMIN_GAME_REPORTING,
  GAME_CATEGORY_RULE_CATALOG,
  createGameCategoryRuleCatalog,
  defineGameCategoryRule,
} from '@openora/core/contracts';
import { createDefaultGameCategoryRules } from '@openora/core/casino/server';
import * as z from 'zod';
import { globalStore } from './global-store.js';

type Scripted = { kind: 'ids'; gameIds: string[] } | { kind: 'fail' } | { kind: 'broad' };

const SCRIPT_STORE = Symbol.for('openora.testing.scripted-rule');
const isScripts = (value: unknown): value is Map<string, Scripted> => value instanceof Map;
const scripts = globalStore(SCRIPT_STORE, isScripts, () => new Map<string, Scripted>());

export const SCRIPTED_RULE_KEY = 'test_scripted';
export const BROAD_MATCH_COUNT = 5001;

export const scriptedRule = (name: string) => [{ key: SCRIPTED_RULE_KEY, params: { name } }];

export const scriptMatches = (name: string, gameIds: string[]) => {
  scripts.set(name, { kind: 'ids', gameIds });
};

export const scriptFailure = (name: string) => {
  scripts.set(name, { kind: 'fail' });
};

export const scriptBroadMatch = (name: string) => {
  scripts.set(name, { kind: 'broad' });
};

export default {
  id: 'test-scripted-rule',
  dependsOn: ['gaming'],
  register(ctx) {
    ctx.provide(GAME_CATEGORY_RULE_CATALOG, (c) =>
      createGameCategoryRuleCatalog([
        ...createDefaultGameCategoryRules(c.get(DRIZZLE), c.get(ADMIN_GAME_REPORTING)),
        defineGameCategoryRule({
          key: SCRIPTED_RULE_KEY,
          paramsSchema: z.object({ name: z.string().min(1) }).strict(),
          async resolve({ params }) {
            const script = scripts.get(params.name);
            if (script?.kind === 'fail') {
              throw new Error('scripted rule failure');
            }
            if (script?.kind === 'broad') {
              return Array.from({ length: BROAD_MATCH_COUNT }, () => randomUUID());
            }
            return script?.gameIds ?? [];
          },
        }),
      ]),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

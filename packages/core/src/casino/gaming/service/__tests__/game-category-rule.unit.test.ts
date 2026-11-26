import fc from 'fast-check';
import * as z from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createGameCategoryRuleCatalog,
  defineGameCategoryRule,
  type GameCategoryRuleChange,
  type GameCategoryRuleResolveInput,
} from '@openora/core/contracts';
import { DrizzleService } from '@openora/core/server';
import {
  GameCategoryRuleInvalidError,
  GameCategoryRuleService,
  GameCategoryRuleTooBroadError,
  GameCategoryRuleUnavailableError,
  GameSearchRuleTooBroadError,
  isRuleAffectedBy,
  isUnresolvableRuleError,
} from '../game-category-rule.service.js';
import { ADMIN_GAME_RULE_MATCH_MAX, GAME_CATEGORY_RULE_MATCH_MAX } from '../../contract/index.js';

const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const A = uuid(0xa);
const B = uuid(0xb);
const C = uuid(0xc);

const change = (over: Partial<GameCategoryRuleChange>): GameCategoryRuleChange => ({
  providerIds: [],
  tagIds: [],
  playabilityChanged: false,
  ...over,
});

const providersRule = defineGameCategoryRule({
  key: 'providers',
  paramsSchema: z.object({ providerIds: z.array(z.string()) }),
  resolve: async () => [],
  isAffectedBy: (params, moved) => moved.providerIds.some((id) => params.providerIds.includes(id)),
});

const sweepOnlyRule = defineGameCategoryRule({
  key: 'sweep_only',
  paramsSchema: z.object({}),
  resolve: async () => [],
});

const resolving = (
  key: string,
  resolve: (input: GameCategoryRuleResolveInput<unknown>) => Promise<string[]>,
) => defineGameCategoryRule({ key, paramsSchema: z.object({}), resolve });

const drizzle = new DrizzleService('postgres://unit:unit@127.0.0.1:1/unit');
afterAll(() => drizzle.dispose());

const serviceWith = (...definitions: Parameters<typeof createGameCategoryRuleCatalog>[0]) =>
  new GameCategoryRuleService(drizzle, createGameCategoryRuleCatalog(definitions));

describe('isUnresolvableRuleError', () => {
  it.each([
    ['invalid rule', new GameCategoryRuleInvalidError('bad'), true],
    ['too broad rule', new GameCategoryRuleTooBroadError(9000), true],
    ['unavailable definition', new GameCategoryRuleUnavailableError('down'), false],
    ['plain error', new Error('bad'), false],
    ['string', 'bad', false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('%s is %s', (_label, error, expected) => {
    expect(isUnresolvableRuleError(error)).toBe(expected);
  });
});

describe('isRuleAffectedBy', () => {
  const catalog = createGameCategoryRuleCatalog([providersRule, sweepOnlyRule]);

  it('is false for an empty rule', () => {
    expect(isRuleAffectedBy(catalog, [], change({ providerIds: ['p1'] }))).toBe(false);
  });

  it('is true when a clause definition says the change touches it', () => {
    expect(
      isRuleAffectedBy(
        catalog,
        [{ key: 'providers', params: { providerIds: ['p1'] } }],
        change({ providerIds: ['p1'] }),
      ),
    ).toBe(true);
  });

  it('is false when the change misses the clause params', () => {
    expect(
      isRuleAffectedBy(
        catalog,
        [{ key: 'providers', params: { providerIds: ['p1'] } }],
        change({ providerIds: ['p2'] }),
      ),
    ).toBe(false);
  });

  it('never triggers for a key with no definition', () => {
    expect(
      isRuleAffectedBy(
        catalog,
        [{ key: 'removed_rule', params: {} }],
        change({ providerIds: ['p1'] }),
      ),
    ).toBe(false);
  });

  it('never triggers for a definition without isAffectedBy', () => {
    expect(
      isRuleAffectedBy(
        catalog,
        [{ key: 'sweep_only', params: {} }],
        change({ playabilityChanged: true }),
      ),
    ).toBe(false);
  });

  it('never triggers when stored params no longer parse', () => {
    expect(
      isRuleAffectedBy(
        catalog,
        [{ key: 'providers', params: { providerIds: 'p1' } }],
        change({ providerIds: ['p1'] }),
      ),
    ).toBe(false);
  });

  it('is true when only a later clause is affected', () => {
    expect(
      isRuleAffectedBy(
        catalog,
        [
          { key: 'sweep_only', params: {} },
          { key: 'providers', params: { providerIds: ['p1'] } },
        ],
        change({ providerIds: ['p1'] }),
      ),
    ).toBe(true);
  });
});

describe('bindClause through the rule service', () => {
  it('rejects an unknown rule key as an invalid rule', async () => {
    await expect(
      serviceWith(providersRule).resolveGameIds([{ key: 'nope', params: {} }]),
    ).rejects.toThrow(GameCategoryRuleInvalidError);
  });

  it('rejects params that fail the definition schema with the clause key in the message', async () => {
    await expect(
      serviceWith(providersRule).resolveGameIds([{ key: 'providers', params: { providerIds: 5 } }]),
    ).rejects.toThrow(/^providers: /);
  });

  it('hands the parsed params to resolve, not the raw ones', async () => {
    const seen: unknown[] = [];
    const coercing = defineGameCategoryRule({
      key: 'coerce',
      paramsSchema: z.object({ limit: z.coerce.number() }),
      resolve: async ({ params }) => {
        seen.push(params);
        return [A];
      },
    });
    await serviceWith(coercing).resolveGameIds([{ key: 'coerce', params: { limit: '5' } }]);
    expect(seen).toEqual([{ limit: 5 }]);
  });
});

describe('resolveGameIds pipeline', () => {
  it('returns nothing for an empty rule', async () => {
    expect(await serviceWith().resolveGameIds([])).toEqual([]);
  });

  it('gives the first clause no candidates and the date it was called with', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const seen: GameCategoryRuleResolveInput<unknown>[] = [];
    const first = resolving('first', async (input) => {
      seen.push(input);
      return [A];
    });
    await serviceWith(first).resolveGameIds([{ key: 'first', params: {} }], now);
    expect(seen[0]?.candidateIds).toBeNull();
    expect(seen[0]?.now).toBe(now);
  });

  it('lowercases ids, strips malformed ones and de-duplicates in first-seen order', async () => {
    const messy = resolving('messy', async () => [
      B.toUpperCase(),
      'not-a-uuid',
      A,
      B,
      '',
      A.toUpperCase(),
    ]);
    expect(await serviceWith(messy).resolveGameIds([{ key: 'messy', params: {} }])).toEqual([B, A]);
  });

  it('drops ids that are not strings', async () => {
    const odd = resolving('odd', async () => JSON.parse(`["${A}", 5, null, {"id": "x"}]`));
    expect(await serviceWith(odd).resolveGameIds([{ key: 'odd', params: {} }])).toEqual([A]);
  });

  it('narrows each later clause to what the previous one left, keeping the later clause order', async () => {
    const first = resolving('first', async () => [A, B, C]);
    const second = resolving('second', async ({ candidateIds }) => {
      expect(candidateIds).toEqual([A, B, C]);
      return [C.toUpperCase(), uuid(0xd), A];
    });
    expect(
      await serviceWith(first, second).resolveGameIds([
        { key: 'first', params: {} },
        { key: 'second', params: {} },
      ]),
    ).toEqual([C, A]);
  });

  it('stops at the first empty clause without calling the next one', async () => {
    let called = false;
    const empty = resolving('empty', async () => []);
    const never = resolving('never', async () => {
      called = true;
      return [A];
    });
    expect(
      await serviceWith(empty, never).resolveGameIds([
        { key: 'empty', params: {} },
        { key: 'never', params: {} },
      ]),
    ).toEqual([]);
    expect(called).toBe(false);
  });

  it('treats a result of only malformed ids as an empty match', async () => {
    const junk = resolving('junk', async () => ['x', 'y']);
    expect(await serviceWith(junk).resolveGameIds([{ key: 'junk', params: {} }])).toEqual([]);
  });

  it.each([
    ['null', 'null'],
    ['an object', `{"0": "${A}"}`],
    ['a string', `"${A}"`],
    ['a number', '5'],
  ])(
    'rejects a definition that returns %s as invalid instead of emptying the category',
    async (_label, raw) => {
      const broken = resolving('broken', async () => JSON.parse(raw));
      await expect(
        serviceWith(broken).resolveGameIds([{ key: 'broken', params: {} }]),
      ).rejects.toThrow(GameCategoryRuleInvalidError);
    },
  );

  it('maps a throwing definition to a retryable unavailable error that hides its message', async () => {
    const throwing = resolving('throwing', async () => {
      throw new Error('upstream secret detail');
    });
    const error = await serviceWith(throwing)
      .resolveGameIds([{ key: 'throwing', params: {} }])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GameCategoryRuleUnavailableError);
    expect(error instanceof Error ? error.message : '').not.toContain('secret');
  });

  it('allows exactly the match cap and rejects one over', async () => {
    const many = (count: number) =>
      resolving('many', async () => Array.from({ length: count }, (_, index) => uuid(index + 1)));
    expect(
      await serviceWith(many(GAME_CATEGORY_RULE_MATCH_MAX)).resolveGameIds([
        { key: 'many', params: {} },
      ]),
    ).toHaveLength(GAME_CATEGORY_RULE_MATCH_MAX);
    await expect(
      serviceWith(many(GAME_CATEGORY_RULE_MATCH_MAX + 1)).resolveGameIds([
        { key: 'many', params: {} },
      ]),
    ).rejects.toThrow(GameCategoryRuleTooBroadError);
  });

  it('counts the cap after de-duplication, not before', async () => {
    const repeated = resolving('repeated', async () =>
      Array.from({ length: GAME_CATEGORY_RULE_MATCH_MAX * 2 }, (_, index) =>
        uuid((index % GAME_CATEGORY_RULE_MATCH_MAX) + 1),
      ),
    );
    expect(
      await serviceWith(repeated).resolveGameIds([{ key: 'repeated', params: {} }]),
    ).toHaveLength(GAME_CATEGORY_RULE_MATCH_MAX);
  });

  it('applies the cap to a middle clause even when a later clause would narrow it back', async () => {
    const wide = resolving('wide', async () =>
      Array.from({ length: GAME_CATEGORY_RULE_MATCH_MAX + 1 }, (_, index) => uuid(index + 1)),
    );
    const narrow = resolving('narrow', async () => [A]);
    await expect(
      serviceWith(wide, narrow).resolveGameIds([
        { key: 'wide', params: {} },
        { key: 'narrow', params: {} },
      ]),
    ).rejects.toThrow(GameCategoryRuleTooBroadError);
  });

  it('uses the larger admin cap and its own error for the search filter', async () => {
    const many = (count: number) =>
      resolving('many', async () => Array.from({ length: count }, (_, index) => uuid(index + 1)));
    expect(
      await serviceWith(many(ADMIN_GAME_RULE_MATCH_MAX)).resolveSearchGameIds([
        { key: 'many', params: {} },
      ]),
    ).toHaveLength(ADMIN_GAME_RULE_MATCH_MAX);
    const error = await serviceWith(many(ADMIN_GAME_RULE_MATCH_MAX + 1))
      .resolveSearchGameIds([{ key: 'many', params: {} }])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GameSearchRuleTooBroadError);
  });

  it('never returns an id outside the first clause result, with no duplicates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 30 }),
        fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 30 }),
        async (firstIds, secondIds) => {
          const first = resolving('first', async () => firstIds.map(uuid));
          const second = resolving('second', async () => secondIds.map(uuid));
          const result = await serviceWith(first, second).resolveGameIds([
            { key: 'first', params: {} },
            { key: 'second', params: {} },
          ]);
          expect(new Set(result).size).toBe(result.length);
          expect(result.every((id) => firstIds.map(uuid).includes(id))).toBe(true);
          expect(result.every((id) => secondIds.map(uuid).includes(id))).toBe(true);
        },
      ),
    );
  });
});

describe('normalizeRule', () => {
  it('returns each clause with its parsed params', async () => {
    expect(
      await serviceWith(providersRule).normalizeRule([
        { key: 'providers', params: { providerIds: ['p1'], extra: 'dropped' } },
      ]),
    ).toEqual([{ key: 'providers', params: { providerIds: ['p1'] } }]);
  });

  it('rejects a validate issue as an invalid rule', async () => {
    const validated = defineGameCategoryRule({
      key: 'validated',
      paramsSchema: z.object({}),
      resolve: async () => [],
      validate: async () => 'provider does not exist',
    });
    await expect(
      serviceWith(validated).normalizeRule([{ key: 'validated', params: {} }]),
    ).rejects.toThrow('validated: provider does not exist');
  });

  it('maps a throwing validate to unavailable, not invalid', async () => {
    const validated = defineGameCategoryRule({
      key: 'validated',
      paramsSchema: z.object({}),
      resolve: async () => [],
      validate: async () => {
        throw new Error('db timeout');
      },
    });
    await expect(
      serviceWith(validated).normalizeRule([{ key: 'validated', params: {} }]),
    ).rejects.toThrow(GameCategoryRuleUnavailableError);
  });

  it('rejects params a schema transforms into something jsonb cannot hold', async () => {
    const dated = defineGameCategoryRule({
      key: 'dated',
      paramsSchema: z.object({ since: z.coerce.date() }),
      resolve: async () => [],
    });
    await expect(
      serviceWith(dated).normalizeRule([{ key: 'dated', params: { since: '2026-01-01' } }]),
    ).rejects.toThrow('dated: params must be plain JSON');
  });
});

import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createGameCategoryRuleCatalog, defineGameCategoryRule } from '@openora/core/contracts';
import { diffMembership } from '../service/game-category-membership.service.js';
import { membershipChangeForGameUpdate } from '../service/game-category-membership-trigger.service.js';
import { isRuleAffectedBy } from '../service/game-category-rule.service.js';

const PROVIDER_A = '11111111-1111-4111-8111-111111111111';
const PROVIDER_B = '22222222-2222-4222-8222-222222222222';
const TAG_A = '33333333-3333-4333-8333-333333333333';
const TAG_B = '44444444-4444-4444-8444-444444444444';

describe('diffMembership', () => {
  it('adds what is matched but absent and removes what is present but unmatched', () => {
    expect(diffMembership(['a', 'b'], ['b', 'c'])).toEqual({ toAdd: ['c'], toRemove: ['a'] });
  });

  it('is empty when the sets already agree, whatever their order', () => {
    expect(diffMembership(['a', 'b'], ['b', 'a'])).toEqual({ toAdd: [], toRemove: [] });
  });

  it('removes everything for an empty match and ignores a duplicated match', () => {
    expect(diffMembership(['a'], [])).toEqual({ toAdd: [], toRemove: ['a'] });
    expect(diffMembership([], ['a', 'a'])).toEqual({ toAdd: ['a'], toRemove: [] });
  });
});

describe('isRuleAffectedBy', () => {
  const quiet = { providerIds: [], tagIds: [], playabilityChanged: false };
  const idsParams = z.object({ ids: z.array(z.string()) }).strict();
  const catalog = createGameCategoryRuleCatalog([
    defineGameCategoryRule({
      key: 'by_provider',
      paramsSchema: idsParams,
      resolve: async () => [],
      isAffectedBy: (params, change) => params.ids.some((id) => change.providerIds.includes(id)),
    }),
    defineGameCategoryRule({
      key: 'by_playability',
      paramsSchema: z.object({}).strict(),
      resolve: async () => [],
      isAffectedBy: (_params, change) => change.playabilityChanged,
    }),
    defineGameCategoryRule({
      key: 'sweep_only',
      paramsSchema: z.object({}).strict(),
      resolve: async () => [],
    }),
  ]);
  const byProvider = { key: 'by_provider', params: { ids: [PROVIDER_A] } };

  it('is true when any clause says the change can reach it', () => {
    const rule = [byProvider, { key: 'by_playability', params: {} }];
    expect(isRuleAffectedBy(catalog, rule, { ...quiet, providerIds: [PROVIDER_A] })).toBe(true);
    expect(isRuleAffectedBy(catalog, rule, { ...quiet, playabilityChanged: true })).toBe(true);
  });

  it('is false when no clause is reached', () => {
    expect(isRuleAffectedBy(catalog, [byProvider], { ...quiet, providerIds: [PROVIDER_B] })).toBe(
      false,
    );
    expect(isRuleAffectedBy(catalog, [byProvider], { ...quiet, playabilityChanged: true })).toBe(
      false,
    );
  });

  it('never triggers on a clause with no isAffectedBy, an unbound key, or stale params', () => {
    const loud = { providerIds: [PROVIDER_A], tagIds: [TAG_A], playabilityChanged: true };
    expect(isRuleAffectedBy(catalog, [{ key: 'sweep_only', params: {} }], loud)).toBe(false);
    expect(isRuleAffectedBy(catalog, [{ key: 'removed_kind', params: {} }], loud)).toBe(false);
    expect(isRuleAffectedBy(catalog, [{ key: 'by_provider', params: { ids: 7 } }], loud)).toBe(
      false,
    );
  });
});

describe('membershipChangeForGameUpdate', () => {
  const base = { providerId: PROVIDER_A, isActive: true, tagIds: [TAG_A] };

  it('is null when provider, tags and active state are unchanged', () => {
    expect(membershipChangeForGameUpdate(base, { ...base, tagIds: [TAG_A] })).toBeNull();
  });

  it('names both providers when the game moved between them', () => {
    expect(membershipChangeForGameUpdate(base, { ...base, providerId: PROVIDER_B })).toEqual({
      providerIds: [PROVIDER_A, PROVIDER_B],
      tagIds: [],
      playabilityChanged: true,
    });
  });

  it('names only the tags that were added or removed', () => {
    expect(membershipChangeForGameUpdate(base, { ...base, tagIds: [TAG_B] })).toEqual({
      providerIds: [],
      tagIds: [TAG_A, TAG_B],
      playabilityChanged: false,
    });
  });

  it('flags an active flip as a playability change', () => {
    expect(membershipChangeForGameUpdate(base, { ...base, isActive: false })).toEqual({
      providerIds: [],
      tagIds: [],
      playabilityChanged: true,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { isMappingConstraint } from '../game-provider.service.js';

describe('isMappingConstraint', () => {
  it.each([
    ['game_provider_aggregator_mapping_provider_aggregator_key', true],
    ['game_provider_aggregator_mapping_aggregator_vendor_id_key', true],
    ['game_provider_slug_key', false],
    ['GAME_PROVIDER_AGGREGATOR_MAPPING_PROVIDER_AGGREGATOR_KEY', false],
    ['game_provider_aggregator_mapping_provider_aggregator_key ', false],
    ['game_provider_aggregator_mapping', false],
    ['', false],
    [null, false],
  ])('%j is %s', (name, expected) => {
    expect(isMappingConstraint(name)).toBe(expected);
  });
});

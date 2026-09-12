import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createLobbySectionCatalog, defineLobbySection } from '../lobby-section-catalog.js';

const definition = defineLobbySection({
  type: 'promotion-carousel',
  configSchema: z.object({ campaignIds: z.array(z.string()) }).strict(),
  async resolve(sections) {
    return new Map(
      sections.map((section) => [section.id, { campaigns: section.config.campaignIds }]),
    );
  },
});

describe('lobby section catalog', () => {
  it('preserves typed definition config behind the generic catalog port', async () => {
    const catalog = createLobbySectionCatalog([definition]);
    const registered = catalog.get('promotion-carousel');
    if (!registered) {
      throw new Error('definition was not registered');
    }
    const config = registered.parseConfig({ campaignIds: ['one'] });
    expect(await registered.resolve([{ id: 'section', config }])).toEqual(
      new Map([['section', { campaigns: ['one'] }]]),
    );
  });

  it('rejects duplicate section type registrations', () => {
    expect(() => createLobbySectionCatalog([definition, definition])).toThrow(
      'Duplicate lobby section definition',
    );
  });
});

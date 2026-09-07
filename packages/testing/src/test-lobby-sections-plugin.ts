import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  LOBBY_SECTION_CATALOG,
  createLobbySectionCatalog,
  defineLobbySection,
  type LobbySectionConfig,
} from '@openora/core/contracts';

function parseTestConfig(config: LobbySectionConfig) {
  const title = config['title'];
  const gameId = config['gameId'];
  if (typeof title !== 'string' || typeof gameId !== 'string') {
    throw new Error('title and gameId must be strings');
  }
  return { title, gameId };
}

export default {
  id: 'test-lobby-sections',
  dependsOn: ['lobby'],
  register(ctx) {
    ctx.provide(LOBBY_SECTION_CATALOG, () =>
      createLobbySectionCatalog([
        defineLobbySection({
          type: 'test-game',
          configSchema: { parse: parseTestConfig },
          async resolve(sections) {
            return new Map(
              sections.map((section) => [
                section.id,
                { ...parseTestConfig(section.config), resolved: true },
              ]),
            );
          },
        }),
      ]),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

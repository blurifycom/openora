import { eq } from 'drizzle-orm';
import { DRIZZLE, type CoreTokenCatalog, type Plugin } from '@openora/core/server';
import {
  LOBBY_SECTION_CATALOG,
  createLobbySectionCatalog,
  defineLobbySection,
  type LobbySectionConfig,
} from '@openora/core/contracts';
import { lobbyCategory } from '@openora/core/casino/schema/lobby';

function parseCategoryConfig(config: LobbySectionConfig) {
  const categoryId = config['categoryId'];
  if (typeof categoryId !== 'string') {
    throw new Error('categoryId must be a string');
  }
  return { categoryId };
}

function parseNoteConfig(config: LobbySectionConfig) {
  const title = config['title'];
  if (typeof title !== 'string') {
    throw new Error('title must be a string');
  }
  return { title };
}

export default {
  id: 'testing-lobby-category-section',
  dependsOn: ['lobby'],
  register(ctx) {
    ctx.provide(LOBBY_SECTION_CATALOG, (c) => {
      const db = c.get(DRIZZLE).db;
      return createLobbySectionCatalog([
        defineLobbySection({
          type: 'test-category',
          configSchema: { parse: parseCategoryConfig },
          async validate(sections) {
            for (const section of sections) {
              const [found] = await db
                .select({ id: lobbyCategory.id })
                .from(lobbyCategory)
                .where(eq(lobbyCategory.id, section.config.categoryId));
              if (!found) {
                return { valid: false, message: `category ${section.config.categoryId} not found` };
              }
            }
            return { valid: true };
          },
          async resolve(sections) {
            return new Map(sections.map((section) => [section.id, { ...section.config }]));
          },
        }),
        defineLobbySection({
          type: 'test-note',
          configSchema: { parse: parseNoteConfig },
          async resolve(sections) {
            return new Map(sections.map((section) => [section.id, { ...section.config }]));
          },
        }),
      ]);
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

import {
  LobbySectionTypeSchema,
  type LobbySectionConfig,
  type LobbySectionData,
  type LobbySectionType,
} from '../schemas/lobby.js';
import { createToken, type Token } from './token.js';

export type LobbySectionDefinitionInput = {
  id: string;
  config: LobbySectionConfig;
};

export type LobbySectionValidationResult = { valid: true } | { valid: false; message: string };

export type LobbySectionDefinition = {
  type: LobbySectionType;
  parseConfig(config: LobbySectionConfig): LobbySectionConfig;
  validate?(sections: LobbySectionDefinitionInput[]): Promise<LobbySectionValidationResult>;
  resolve(sections: LobbySectionDefinitionInput[]): Promise<Map<string, LobbySectionData>>;
};

export type LobbySectionCatalog = {
  get(type: string): LobbySectionDefinition | undefined;
  list(): LobbySectionDefinition[];
};

export function defineLobbySection<
  const Type extends string,
  Config extends LobbySectionConfig,
  Data extends LobbySectionData,
>(definition: {
  type: Type;
  configSchema: { parse(input: unknown): Config };
  validate?(sections: Array<{ id: string; config: Config }>): Promise<LobbySectionValidationResult>;
  resolve(sections: Array<{ id: string; config: Config }>): Promise<Map<string, Data>>;
}): LobbySectionDefinition {
  const validate = definition.validate;
  const parseSections = (sections: LobbySectionDefinitionInput[]) =>
    sections.map((section) => ({
      id: section.id,
      config: definition.configSchema.parse(section.config),
    }));
  return {
    type: LobbySectionTypeSchema.parse(definition.type),
    parseConfig: (config) => definition.configSchema.parse(config),
    validate: validate ? (sections) => validate(parseSections(sections)) : undefined,
    async resolve(sections) {
      const resolved = await definition.resolve(parseSections(sections));
      return new Map<string, LobbySectionData>(resolved);
    },
  };
}

export function createLobbySectionCatalog(
  definitions: readonly LobbySectionDefinition[],
): LobbySectionCatalog {
  const byType = new Map<string, LobbySectionDefinition>();
  for (const definition of definitions) {
    const type = LobbySectionTypeSchema.parse(definition.type);
    if (byType.has(type)) {
      throw new Error(`Duplicate lobby section definition: ${type}`);
    }
    byType.set(type, definition);
  }
  return {
    get: (type) => byType.get(type),
    list: () => [...byType.values()],
  };
}

export const LOBBY_SECTION_CATALOG: Token<LobbySectionCatalog> =
  createToken<LobbySectionCatalog>('LOBBY_SECTION_CATALOG');

import { isDeepStrictEqual } from 'node:util';
import { createDomainError } from '@openora/core/server';
import { GameSortParamsSchema, type GameSortCatalog } from '@openora/core/contracts';
import type { GameCategory } from '../schema/index.js';
import type { UpdateCategoryInput } from '../contract/index.js';
import { paramsJsonSchema } from '../../shared/catalog-options.js';

export const GameSortConfigInvalidError = createDomainError<[message: string]>(
  'GameSortConfigInvalidError',
  (message) => message,
);

export class GameSortService {
  constructor(private readonly catalog: GameSortCatalog) {}

  requireDefinition(key: GameCategory['sortKey']) {
    const definition = this.catalog.get(key);
    if (!definition) {
      throw new GameSortConfigInvalidError(`Unknown sort key: ${key}`);
    }
    return definition;
  }

  resolvePatch(
    existing: Pick<GameCategory, 'sortKey' | 'sortDirection' | 'sortParams'>,
    input: Pick<UpdateCategoryInput, 'sortKey' | 'sortDirection' | 'sortParams'>,
  ) {
    const nextKey = input.sortKey ?? existing.sortKey;
    const definition = this.requireDefinition(nextKey);
    if (
      input.sortDirection !== undefined &&
      input.sortDirection !== null &&
      !definition.directions.includes(input.sortDirection)
    ) {
      throw new GameSortConfigInvalidError(
        `'${input.sortDirection}' is not a valid direction for sort '${nextKey}'`,
      );
    }
    const keyChanged = nextKey !== existing.sortKey;
    const existingDirection =
      !keyChanged &&
      existing.sortDirection !== null &&
      definition.directions.includes(existing.sortDirection)
        ? existing.sortDirection
        : definition.directions[0];
    const effectiveDirection =
      input.sortDirection === undefined
        ? existingDirection
        : (input.sortDirection ?? definition.directions[0]);
    const sortDirection = definition.directions.length > 1 ? effectiveDirection : null;
    const rawParams = input.sortParams ?? (keyChanged ? {} : (existing.sortParams ?? {}));
    const definitionParams = definition.paramsSchema.safeParse(rawParams);
    const parsedParams = definitionParams.success
      ? GameSortParamsSchema.safeParse(definitionParams.data)
      : definitionParams;
    if (!parsedParams.success) {
      throw new GameSortConfigInvalidError(`Invalid sortParams for sort '${nextKey}'`);
    }
    return {
      changed:
        nextKey !== existing.sortKey ||
        sortDirection !== existing.sortDirection ||
        !isDeepStrictEqual(parsedParams.data, existing.sortParams ?? {}),
      patch: { sortKey: nextKey, sortDirection, sortParams: parsedParams.data },
    };
  }

  listOptions() {
    return this.catalog.list().map((definition) => ({
      key: definition.key,
      directions: [...definition.directions],
      paramsJsonSchema: paramsJsonSchema(definition.paramsSchema),
    }));
  }
}

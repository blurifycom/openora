import { randomUUID } from 'node:crypto';
import { asc, eq, notInArray, sql } from 'drizzle-orm';
import {
  cached,
  createDomainError,
  createLogger,
  invalidate,
  mapConcurrent,
  makeNotFoundError,
  serializeRow,
  withAdvisoryXactLock,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import type {
  CacheAdapter,
  ClientMeta,
  LobbySectionCatalog,
  LobbySectionData,
  LobbySectionDefinition,
  LobbySectionDefinitionInput,
  LobbySectionType,
  User,
} from '@openora/core/contracts';
import type {
  LobbyAdminLayout,
  LobbyAdminSection,
  LobbyResolvedSection,
  ReplaceLobbyLayoutInput,
} from '../contract/index.js';
import { lobbyLayout, lobbySection } from '../schema/index.js';
export const LobbySectionNotFoundError = makeNotFoundError('LobbySection');
export const LobbySectionFieldError = createDomainError<[message: string]>(
  'LobbySectionFieldError',
  (message) => message,
);
export const LobbyLayoutVersionConflictError = createDomainError<
  [expectedVersion: number, actualVersion: number]
>(
  'LobbyLayoutVersionConflictError',
  (expectedVersion, actualVersion) =>
    `Lobby layout version ${expectedVersion} is stale; current version is ${actualVersion}`,
);

type Actor = {
  actorId?: User['id'];
} & ClientMeta;

type PreparedLayoutSection = {
  id: string;
  isNew: boolean;
  type: LobbySectionType;
  config: (typeof lobbySection.$inferInsert)['config'];
  isEnabled: boolean;
  sortOrder: number;
};

const logger = createLogger('lobby');

const GLOBAL_LAYOUT_KEY = 'global';
const LAYOUT_LOCK_KEY = 'lobby:global-layout';
const LOBBY_CACHE_TTL_MS = 30_000;
const LAYOUT_CACHE_KEY = 'lobby:layout';
const SECTION_OPERATION_CONCURRENCY = 5;

export class LobbyService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly sectionCatalog: LobbySectionCatalog,
    private readonly cache?: CacheAdapter,
  ) {}

  async getLayout() {
    return cached(this.cache, LAYOUT_CACHE_KEY, LOBBY_CACHE_TTL_MS, () => this.loadLayout());
  }

  async getAdminLayout(): Promise<LobbyAdminLayout> {
    return this.drizzle.db.transaction(
      async (tx) => {
        const [layout] = await tx
          .select({ version: lobbyLayout.version })
          .from(lobbyLayout)
          .where(eq(lobbyLayout.layoutKey, GLOBAL_LAYOUT_KEY));
        return {
          version: layout?.version ?? 0,
          sections: await this.loadAdminSections(tx),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async replaceLayout(input: ReplaceLobbyLayoutInput & Actor): Promise<LobbyAdminLayout> {
    const { actorId, ip, userAgent } = input;
    this.assertUniqueSectionIds(input.sections.flatMap((section) => section.id ?? []));
    const preparedSections = input.sections.map((section, sortOrder) => {
      const definition = this.requireDefinition(section.type);
      return {
        id: section.id ?? randomUUID(),
        isNew: section.id === undefined,
        type: section.type,
        config: this.parseConfig(definition, section.config),
        isEnabled: section.isEnabled,
        sortOrder,
      };
    });
    await this.validateSections(preparedSections);

    const { before, after } = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, LAYOUT_LOCK_KEY, async () => {
        await tx
          .insert(lobbyLayout)
          .values({ layoutKey: GLOBAL_LAYOUT_KEY })
          .onConflictDoNothing({ target: lobbyLayout.layoutKey });
        const [layout] = await tx
          .select()
          .from(lobbyLayout)
          .where(eq(lobbyLayout.layoutKey, GLOBAL_LAYOUT_KEY))
          .for('update');
        if (!layout) {
          throw new Error('Lobby layout row missing after upsert');
        }
        if (layout.version !== input.version) {
          throw new LobbyLayoutVersionConflictError(input.version, layout.version);
        }

        const before = { version: layout.version, sections: await this.loadAdminSections(tx) };
        this.assertExistingSectionIds(before.sections, preparedSections);
        await this.replaceSections(tx, preparedSections);

        const nextVersion = layout.version + 1;
        await tx
          .update(lobbyLayout)
          .set({ version: nextVersion })
          .where(eq(lobbyLayout.id, layout.id));
        const after = { version: nextVersion, sections: await this.loadAdminSections(tx) };
        return { before, after };
      }),
    );

    await invalidate(this.cache, LAYOUT_CACHE_KEY);
    this.events.emit('lobby.layout.updated', {
      actorId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      before,
      after,
    });
    return after;
  }

  private async loadLayout(): Promise<LobbyResolvedSection[]> {
    const sections = await this.drizzle.db
      .select()
      .from(lobbySection)
      .where(eq(lobbySection.isEnabled, true))
      .orderBy(asc(lobbySection.sortOrder), asc(lobbySection.createdAt));
    const groups = this.groupSections(sections);
    const resolvedGroups = await mapConcurrent(
      [...groups.entries()],
      SECTION_OPERATION_CONCURRENCY,
      async ([type, group]) => {
        const definition = this.sectionCatalog.get(type);
        if (!definition) {
          logger.warn(
            { type, sectionIds: group.map((section) => section.id) },
            'Skipping lobby sections with unknown type',
          );
          return new Map<string, { id: string; type: string; data: LobbySectionData }>();
        }
        const validSections: LobbySectionDefinitionInput[] = [];
        for (const section of group) {
          try {
            validSections.push({
              id: section.id,
              config: definition.parseConfig(section.config),
            });
          } catch (err) {
            logger.warn(
              { err, type, sectionId: section.id },
              'Skipping lobby section with invalid config',
            );
          }
        }
        if (validSections.length === 0) {
          return new Map<string, { id: string; type: string; data: LobbySectionData }>();
        }
        let data: Map<string, LobbySectionData>;
        try {
          data = await definition.resolve(validSections);
        } catch (err) {
          logger.warn({ err, type }, 'Skipping lobby sections that failed to resolve');
          return new Map<string, { id: string; type: string; data: LobbySectionData }>();
        }
        const resolved = new Map<string, { id: string; type: string; data: LobbySectionData }>();
        for (const section of group) {
          const sectionData = data.get(section.id);
          if (sectionData === undefined) {
            logger.warn(
              { type, sectionId: section.id },
              'Skipping lobby section that was not resolved',
            );
            continue;
          }
          resolved.set(section.id, { id: section.id, type, data: sectionData });
        }
        return resolved;
      },
    );
    const byId = new Map(resolvedGroups.flatMap((group) => [...group]));
    return sections.flatMap((section) => {
      const resolved = byId.get(section.id);
      return resolved ? [resolved] : [];
    });
  }

  private async validateSections(sections: PreparedLayoutSection[]) {
    const groups = this.groupSections(sections);
    await mapConcurrent(
      [...groups.entries()],
      SECTION_OPERATION_CONCURRENCY,
      async ([type, group]) => {
        const definition = this.requireDefinition(type);
        try {
          const validation = await definition.validate?.(
            group.map((section) => ({ id: section.id, config: section.config })),
          );
          if (validation && !validation.valid) {
            throw new LobbySectionFieldError(
              `Invalid '${type}' section configuration: ${validation.message}`,
            );
          }
        } catch (error) {
          if (error instanceof LobbySectionFieldError) {
            throw error;
          }
          // Section validate is a pure config check (no I/O); any throw is invalid
          // config, never a transient failure. Logged for ops before mapping to 400.
          logger.error({ err: error, type }, 'Lobby section validation failed');
          throw new LobbySectionFieldError(
            `Invalid '${type}' section configuration: ${errorMessage(error)}`,
          );
        }
      },
    );
  }

  private parseConfig(
    definition: LobbySectionDefinition,
    config: (typeof lobbySection.$inferInsert)['config'],
  ) {
    try {
      return definition.parseConfig(config);
    } catch (error) {
      throw new LobbySectionFieldError(
        `Invalid '${definition.type}' section configuration: ${errorMessage(error)}`,
      );
    }
  }

  private groupSections<T extends LobbySectionDefinitionInput & { type: string }>(sections: T[]) {
    const groups = new Map<string, T[]>();
    for (const section of sections) {
      const group = groups.get(section.type);
      if (group) {
        group.push(section);
      } else {
        groups.set(section.type, [section]);
      }
    }
    return groups;
  }

  private requireDefinition(type: string): LobbySectionDefinition {
    const definition = this.sectionCatalog.get(type);
    if (!definition) {
      throw new LobbySectionFieldError(`Unknown lobby section type: ${type}`);
    }
    return definition;
  }

  private async loadAdminSections(tx: DrizzleTx): Promise<LobbyAdminSection[]> {
    const sections = await tx
      .select()
      .from(lobbySection)
      .orderBy(asc(lobbySection.sortOrder), asc(lobbySection.createdAt));
    return sections.map((section) => {
      const serialized = serializeRow(section, { dateFields: ['createdAt', 'updatedAt'] });
      return {
        id: section.id,
        type: section.type,
        config: section.config,
        sortOrder: section.sortOrder,
        isEnabled: section.isEnabled,
        createdAt: serialized.createdAt,
        updatedAt: serialized.updatedAt,
      };
    });
  }

  private assertUniqueSectionIds(sectionIds: string[]) {
    if (new Set(sectionIds).size !== sectionIds.length) {
      throw new LobbySectionFieldError('Section ids must be unique');
    }
  }

  private assertExistingSectionIds(
    existingSections: LobbyAdminSection[],
    preparedSections: PreparedLayoutSection[],
  ) {
    const existingById = new Map(existingSections.map((section) => [section.id, section]));
    for (const section of preparedSections) {
      if (section.isNew) {
        continue;
      }
      const existing = existingById.get(section.id);
      if (!existing) {
        throw new LobbySectionNotFoundError(section.id);
      }
      if (existing.type !== section.type) {
        throw new LobbySectionFieldError(
          `Section type is '${existing.type}', not '${section.type}'`,
        );
      }
    }
  }

  private async replaceSections(tx: DrizzleTx, sections: PreparedLayoutSection[]) {
    const sectionIds = sections.map((section) => section.id);
    if (sectionIds.length === 0) {
      await tx.delete(lobbySection);
      return;
    }
    await tx.delete(lobbySection).where(notInArray(lobbySection.id, sectionIds));
    await tx
      .insert(lobbySection)
      .values(
        sections.map((section) => ({
          id: section.id,
          type: section.type,
          config: section.config,
          sortOrder: section.sortOrder,
          isEnabled: section.isEnabled,
        })),
      )
      .onConflictDoUpdate({
        target: lobbySection.id,
        set: {
          config: sql`excluded.config`,
          sortOrder: sql`excluded.sort_order`,
          isEnabled: sql`excluded.is_enabled`,
          updatedAt: sql`now()`,
        },
      });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'validation failed';
}

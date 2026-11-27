import * as z from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createLobbySectionCatalog,
  defineLobbySection,
  type LobbySectionDefinition,
  type LobbySectionDefinitionInput,
} from '@openora/core/contracts';
import { DrizzleService, type EventBus } from '@openora/core/server';
import { LobbySectionFieldError, LobbyService } from '../lobby.service.js';

const idle: EventBus = {
  emit: () => undefined,
  emitRaw: () => undefined,
  emitInTransaction: async () => undefined,
  on: () => () => undefined,
  tapTransactional: () => undefined,
};

const drizzle = new DrizzleService('postgres://unit:unit@127.0.0.1:1/unit');
afterAll(() => drizzle.dispose());

const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

const recordingSection = (type: string, calls: Array<[string, LobbySectionDefinitionInput[]]>) =>
  defineLobbySection({
    type,
    configSchema: z.object({ title: z.string().optional() }),
    validate: async (sections) => {
      calls.push([type, sections]);
      return { valid: false, message: 'stop before the database' };
    },
    resolve: async () => new Map(),
  });

const serviceWith = (...definitions: LobbySectionDefinition[]) =>
  new LobbyService(drizzle, idle, createLobbySectionCatalog(definitions));

const replace = (
  service: LobbyService,
  sections: Parameters<LobbyService['replaceLayout']>[0]['sections'],
) => service.replaceLayout({ version: 0, sections, ip: null, userAgent: null });

const section = (over: {
  id?: string;
  type?: string;
  config?: Record<string, string | number>;
}) => ({
  type: 'banner',
  config: {},
  isEnabled: true,
  ...over,
});

describe('replaceLayout section checks before any database write', () => {
  it('rejects a repeated section id', async () => {
    const service = serviceWith(recordingSection('banner', []));
    await expect(
      replace(service, [
        section({ id: uuid(1) }),
        section({ id: uuid(2) }),
        section({ id: uuid(1) }),
      ]),
    ).rejects.toThrow('Section ids must be unique');
  });

  it('does not count sections without an id as duplicates of each other', async () => {
    const calls: Array<[string, LobbySectionDefinitionInput[]]> = [];
    const service = serviceWith(recordingSection('banner', calls));
    await expect(replace(service, [section({}), section({})])).rejects.toThrow(
      "Invalid 'banner' section configuration: stop before the database",
    );
    expect(calls[0]?.[1]).toHaveLength(2);
  });

  it('treats ids that differ only by case as different ids', async () => {
    const calls: Array<[string, LobbySectionDefinitionInput[]]> = [];
    const service = serviceWith(recordingSection('banner', calls));
    const lower = 'abcdefab-0000-4000-8000-000000000000';
    await expect(
      replace(service, [section({ id: lower }), section({ id: lower.toUpperCase() })]),
    ).rejects.toThrow('stop before the database');
  });

  it('rejects an unknown section type with the type in the message', async () => {
    const service = serviceWith(recordingSection('banner', []));
    await expect(replace(service, [section({ type: 'ghost' })])).rejects.toThrow(
      'Unknown lobby section type: ghost',
    );
  });

  it('fails on the unknown type even when it comes after valid sections', async () => {
    const calls: Array<[string, LobbySectionDefinitionInput[]]> = [];
    const service = serviceWith(recordingSection('banner', calls));
    await expect(replace(service, [section({}), section({ type: 'ghost' })])).rejects.toThrow(
      LobbySectionFieldError,
    );
    expect(calls).toEqual([]);
  });

  it('wraps a config the definition rejects as a field error naming the type', async () => {
    const service = serviceWith(recordingSection('banner', []));
    const error = await replace(service, [section({ config: { title: 5 } })]).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LobbySectionFieldError);
    expect(error instanceof Error ? error.message : '').toMatch(
      /^Invalid 'banner' section configuration: /,
    );
  });

  it('uses a fixed message when the definition throws something that is not an Error', async () => {
    const throwing: LobbySectionDefinition = {
      type: 'raw',
      parseConfig: () => {
        throw 'plain string';
      },
      resolve: async () => new Map(),
    };
    await expect(replace(serviceWith(throwing), [section({ type: 'raw' })])).rejects.toThrow(
      "Invalid 'raw' section configuration: validation failed",
    );
  });

  it('stores the parsed config, so unknown keys never reach validate', async () => {
    const calls: Array<[string, LobbySectionDefinitionInput[]]> = [];
    const service = serviceWith(recordingSection('banner', calls));
    await replace(service, [section({ id: uuid(1), config: { title: 'x', extra: 'y' } })]).catch(
      () => undefined,
    );
    expect(calls[0]?.[1]).toEqual([{ id: uuid(1), config: { title: 'x' } }]);
  });
});

describe('replaceLayout grouping of sections by type', () => {
  it('validates each type once with all of its sections in layout order', async () => {
    const calls: Array<[string, LobbySectionDefinitionInput[]]> = [];
    const service = serviceWith(
      recordingSection('banner', calls),
      recordingSection('carousel', calls),
    );
    await replace(service, [
      section({ id: uuid(1), type: 'banner', config: { title: 'one' } }),
      section({ id: uuid(2), type: 'carousel' }),
      section({ id: uuid(3), type: 'banner', config: { title: 'three' } }),
      section({ id: uuid(4), type: 'banner', config: { title: 'four' } }),
    ]).catch(() => undefined);
    const byType = new Map(calls);
    expect(calls).toHaveLength(2);
    expect(byType.get('banner')?.map((entry) => entry.id)).toEqual([uuid(1), uuid(3), uuid(4)]);
    expect(byType.get('carousel')?.map((entry) => entry.id)).toEqual([uuid(2)]);
  });

  it('never mixes the sections of two types in one validate call', async () => {
    const calls: Array<[string, LobbySectionDefinitionInput[]]> = [];
    const service = serviceWith(
      recordingSection('banner', calls),
      recordingSection('carousel', calls),
    );
    await replace(
      service,
      Array.from({ length: 12 }, (_, index) =>
        section({ id: uuid(index + 1), type: index % 3 === 0 ? 'carousel' : 'banner' }),
      ),
    ).catch(() => undefined);
    const byType = new Map(calls);
    expect(byType.get('carousel')?.map((entry) => entry.id)).toEqual([
      uuid(1),
      uuid(4),
      uuid(7),
      uuid(10),
    ]);
    expect(byType.get('banner')).toHaveLength(8);
  });
});

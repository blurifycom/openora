import { vi, type Mock } from 'vitest';
import type { AuditWritePort } from '@openora/core/contracts';
import {
  createEventBus,
  DrizzleOutboxWriter,
  type EventBus,
  type ProcessedEventLog,
} from '@openora/core/server';

export const mock = <T>(partial: object = {}): T => partial as unknown as T;

type MockedEventBus = EventBus & { emit: Mock; on: Mock; emitInTransaction: Mock };

export type MockedAuditWriter = AuditWritePort & {
  record: Mock;
  recordInTransaction: Mock;
  recordManyInTransaction: Mock;
};

export const makeEventBus = (): MockedEventBus =>
  mock<MockedEventBus>({ emit: vi.fn(), on: vi.fn(), emitInTransaction: vi.fn() });

export const makeOutboxEventBus = (): EventBus =>
  createEventBus({
    broker: { publish: vi.fn(), subscribe: () => () => {}, close: async () => {} },
    outbox: new DrizzleOutboxWriter(),
    processedEvents: mock<ProcessedEventLog>(),
  });

export const makeAuditWriter = (): MockedAuditWriter => ({
  auditedTopics: new Set<string>(),
  record: vi.fn(async () => undefined),
  recordInTransaction: vi.fn(async () => undefined),
  recordManyInTransaction: vi.fn(async () => undefined),
});

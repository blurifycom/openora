import { createLogger, serializeRow } from '@openora/core/server';
import {
  CommandMetadataSchema,
  MONEY_SCALE,
  type ChatSystemMessage,
} from '@openora/core/contracts';
import type { chatMessage } from '../schema/index.js';

const logger = createLogger('chat');

export function toMessage(record: typeof chatMessage.$inferSelect) {
  return serializeRow(record, { dateFields: ['createdAt'] });
}

const COMMAND_METADATA_MONEY_KEYS = ['amount', 'perRecipient'] as const;

function canonicalizeMoneyString(value: string): string {
  if (!/^\d+\.\d+$/.test(value)) {
    return value;
  }
  const [whole, fraction] = value.split('.') as [string, string];
  if (fraction.length <= MONEY_SCALE) {
    return value;
  }
  const trimmed = fraction.slice(0, MONEY_SCALE).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function sanitizeCommandMetadata(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object') {
    return metadata;
  }
  const entries = Object.entries(metadata as Record<string, unknown>).map(([key, value]) =>
    (COMMAND_METADATA_MONEY_KEYS as readonly string[]).includes(key) && typeof value === 'string'
      ? [key, canonicalizeMoneyString(value)]
      : [key, value],
  );
  return Object.fromEntries(entries);
}

// A system message IS its command metadata, and the column is jsonb - a shape Postgres never
// enforced, so a row can outlive the contract that wrote it. Sanitizing first keeps the
// deliberate repair path (legacy money strings) working; what still fails to parse cannot be
// rendered as any system message the contract describes.
export function toSystemMessage(record: typeof chatMessage.$inferSelect): ChatSystemMessage | null {
  const message = toMessage(record);
  const metadata = CommandMetadataSchema.safeParse(sanitizeCommandMetadata(message.metadata));
  if (!metadata.success) {
    logger.warn(
      { messageId: record.id, issues: metadata.error.issues.slice(0, 3) },
      'system message metadata no longer matches its contract, omitted',
    );
    return null;
  }
  return { ...message, metadata: metadata.data, actorId: message.userId } as ChatSystemMessage;
}

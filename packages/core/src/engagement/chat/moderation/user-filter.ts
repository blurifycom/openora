import { eq, inArray, type Column } from 'drizzle-orm';
import type { ChatModerationUserFilter } from '@openora/core/contracts';

export function moderatedUserFilter(column: Column, users: ChatModerationUserFilter | undefined) {
  if (!users) {
    return undefined;
  }
  return typeof users === 'string' ? eq(column, users) : inArray(column, users);
}

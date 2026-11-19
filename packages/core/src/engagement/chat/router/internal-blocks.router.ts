import { internalProcedureFor } from '@openora/core/server';
import {
  CHAT_BLOCK_READER_ROUTES,
  ChatBlockReaderWire,
  type ChatBlockReader,
} from '@openora/core/contracts';

/**
 * The internal API behind `CHAT_BLOCK_READER`, for a service that does not load chat. Only the
 * services named in `callers` (`CHAT_BLOCK_READER_CALLERS`) may read; any other signed caller is
 * refused. `reader` must be chat's own, never a remote one.
 */
export function createInternalBlocksRouter(reader: ChatBlockReader, callers: ReadonlySet<string>) {
  const procedure = internalProcedureFor(callers, 'This service may not read chat blocks');
  return {
    excluded: procedure
      .route({ method: 'POST', path: CHAT_BLOCK_READER_ROUTES.excluded })
      .input(ChatBlockReaderWire.excluded.input)
      .output(ChatBlockReaderWire.excluded.output)
      .handler(async ({ input }) => ({ userIds: await reader.getExcludedUserIds(input.userId) })),
    blocked: procedure
      .route({ method: 'POST', path: CHAT_BLOCK_READER_ROUTES.blocked })
      .input(ChatBlockReaderWire.blocked.input)
      .output(ChatBlockReaderWire.blocked.output)
      .handler(async ({ input }) => ({ userIds: await reader.getBlockedUserIds(input.userId) })),
    blockers: procedure
      .route({ method: 'POST', path: CHAT_BLOCK_READER_ROUTES.blockers })
      .input(ChatBlockReaderWire.blockers.input)
      .output(ChatBlockReaderWire.blockers.output)
      .handler(async ({ input }) => ({ userIds: await reader.getBlockerIds(input.userId) })),
  };
}

import { internalProcedureFor, type DrizzleService } from '@openora/core/server';
import {
  CHAT_TRANSFER_CHECK_ROUTES,
  ChatTransferCheckWire,
  type ChatTransferCheck,
} from '@openora/core/contracts';

/**
 * The internal API behind `CHAT_TRANSFER_CHECK`, for a service that does not load chat. The
 * check needs a transaction to read through, and the caller's is in another process, so it runs
 * on one of its own that ends with the answer: the block locks are released before the caller
 * moves any money. Only the services named in `callers` (`CHAT_TRANSFER_CHECK_CALLERS`) may ask.
 * `check` must be the local binding, never a remote one.
 */
export function createInternalTransferCheckRouter(
  check: ChatTransferCheck,
  drizzle: DrizzleService,
  callers: ReadonlySet<string>,
) {
  return {
    check: internalProcedureFor(callers, 'This service may not check chat transfers')
      .route({ method: 'POST', path: CHAT_TRANSFER_CHECK_ROUTES.check })
      .input(ChatTransferCheckWire.check.input)
      .output(ChatTransferCheckWire.check.output)
      .handler(({ input }) => drizzle.db.transaction((tx) => check.check(tx, input))),
  };
}

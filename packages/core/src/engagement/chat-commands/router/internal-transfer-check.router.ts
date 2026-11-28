import { internalProcedureFor, type DrizzleService } from '@openora/core/server';
import {
  CHAT_TRANSFER_CHECK_ROUTES,
  ChatTransferCheckWire,
  type ChatTransferCheck,
} from '@openora/core/contracts';

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

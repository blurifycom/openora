import { internalProcedure } from '@openora/core/server';
import {
  ACCOUNT_READER_ROUTES,
  AccountReaderWire,
  type AccountReader,
} from '@openora/core/contracts';

/**
 * The internal API behind `ACCOUNT_READER`, for a service that runs on a database of its own.
 * Every signed caller may read: the answers are what chat already shows its players, and the
 * signature is what keeps the public internet out.
 */
export function createInternalAccountsRouter(reader: AccountReader) {
  return {
    accounts: internalProcedure
      .route({ method: 'POST', path: ACCOUNT_READER_ROUTES.accounts })
      .input(AccountReaderWire.accounts.input)
      .output(AccountReaderWire.accounts.output)
      .handler(async ({ input }) => ({
        accounts: [...(await reader.getAccounts(input.userIds)).values()],
      })),
    byUsername: internalProcedure
      .route({ method: 'POST', path: ACCOUNT_READER_ROUTES.byUsername })
      .input(AccountReaderWire.byUsername.input)
      .output(AccountReaderWire.byUsername.output)
      .handler(async ({ input }) => ({
        account: await reader.findPlayerByUsername(input.username),
      })),
    search: internalProcedure
      .route({ method: 'POST', path: ACCOUNT_READER_ROUTES.search })
      .input(AccountReaderWire.search.input)
      .output(AccountReaderWire.search.output)
      .handler(async ({ input }) => ({ accounts: await reader.searchPlayers(input) })),
    byPlayer: internalProcedure
      .route({ method: 'POST', path: ACCOUNT_READER_ROUTES.byPlayer })
      .input(AccountReaderWire.byPlayer.input)
      .output(AccountReaderWire.byPlayer.output)
      .handler(async ({ input }) => ({
        userId: await reader.findUserIdByPlayerId(input.playerId),
      })),
  };
}

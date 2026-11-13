import { ORPCError } from '@orpc/server';
import { internalProcedure } from '@openora/core/server';
import {
  ACCOUNT_READER_ROUTES,
  AccountReaderWire,
  type AccountReader,
} from '@openora/core/contracts';

/** The services allowed to read accounts: `ACCOUNT_READER_CALLERS`, a comma list of names. */
export function accountReaderCallers(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

/**
 * The internal API behind `ACCOUNT_READER`, for a service that runs on a database of its own.
 * Only the services named in `callers` may read; any other signed caller is refused. This
 * guards against misconfiguration only, not a compromised service: one install-wide secret
 * signs as any caller name.
 */
export function createInternalAccountsRouter(reader: AccountReader, callers: ReadonlySet<string>) {
  const procedure = internalProcedure.use(({ context, next }) => {
    if (!callers.has(context.internalCaller)) {
      throw new ORPCError('FORBIDDEN', { message: 'This service may not read accounts' });
    }
    return next();
  });
  return {
    accounts: procedure
      .route({ method: 'POST', path: ACCOUNT_READER_ROUTES.accounts })
      .input(AccountReaderWire.accounts.input)
      .output(AccountReaderWire.accounts.output)
      .handler(async ({ input }) => ({
        accounts: [...(await reader.getAccounts(input.userIds)).values()],
      })),
    byUsername: procedure
      .route({ method: 'POST', path: ACCOUNT_READER_ROUTES.byUsername })
      .input(AccountReaderWire.byUsername.input)
      .output(AccountReaderWire.byUsername.output)
      .handler(async ({ input }) => ({
        account: await reader.findPlayerByUsername(input.username),
      })),
    search: procedure
      .route({ method: 'POST', path: ACCOUNT_READER_ROUTES.search })
      .input(AccountReaderWire.search.input)
      .output(AccountReaderWire.search.output)
      .handler(async ({ input }) => ({ accounts: await reader.searchPlayers(input) })),
    byPlayer: procedure
      .route({ method: 'POST', path: ACCOUNT_READER_ROUTES.byPlayer })
      .input(AccountReaderWire.byPlayer.input)
      .output(AccountReaderWire.byPlayer.output)
      .handler(async ({ input }) => ({
        userId: await reader.findUserIdByPlayerId(input.playerId),
      })),
  };
}

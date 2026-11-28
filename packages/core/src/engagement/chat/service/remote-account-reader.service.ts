import {
  ACCOUNT_READER_ROUTES,
  ACCOUNTS_BATCH_MAX,
  AccountReaderWire,
  type Account,
  type AccountReader,
  type AccountReadOptions,
  type Player,
  type PlayerMatch,
  type PlayerSearch,
} from '@openora/core/contracts';
import { mapConcurrent, TtlCache, type InternalClient } from '@openora/core/server';

const ACCOUNT_CACHE_TTL_MS = 30_000;
const ACCOUNT_CACHE_MAX_ENTRIES = 10_000;
const BATCH_CONCURRENCY = 4;

export class RemoteAccountReader implements AccountReader {
  private readonly cache: TtlCache<Account, Map<string, Account>>;

  constructor(
    private readonly client: InternalClient,
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache({
      ttlMs: ACCOUNT_CACHE_TTL_MS,
      maxEntries: ACCOUNT_CACHE_MAX_ENTRIES,
      now,
    });
  }

  async getAccounts(
    userIds: readonly string[],
    options: AccountReadOptions = {},
  ): Promise<Map<string, Account>> {
    const uncached = options.fresh || options.playEligibility;
    const found = new Map<string, Account>();
    const joined = new Map<string, Promise<Map<string, Account>>>();
    const missing: string[] = [];
    for (const id of new Set(userIds.map((userId) => userId.toLowerCase()))) {
      const cached = uncached ? undefined : this.cache.get(id);
      const inFlight = uncached ? undefined : this.cache.pending(id);
      if (cached) {
        found.set(id, cached);
      } else if (inFlight) {
        joined.set(id, inFlight);
      } else {
        missing.push(id);
      }
    }
    const fetched = this.fetch(missing, options.playEligibility);
    if (!uncached) {
      this.cache.track(missing, fetched);
    }
    for (const [id, account] of await fetched) {
      found.set(id, account);
    }
    for (const [id, pending] of joined) {
      const account = (await pending).get(id);
      if (account) {
        found.set(id, account);
      }
    }
    return new Map(
      userIds.flatMap((userId) => {
        const account = found.get(userId.toLowerCase());
        return account ? [[userId, account] as const] : [];
      }),
    );
  }

  async findPlayerByUsername(username: string): Promise<PlayerMatch | null> {
    const reply = AccountReaderWire.byUsername.output.parse(
      await this.client.request('POST', ACCOUNT_READER_ROUTES.byUsername, { username }),
    );
    return reply.account;
  }

  async searchPlayers(search: PlayerSearch): Promise<PlayerMatch[]> {
    const reply = AccountReaderWire.search.output.parse(
      await this.client.request('POST', ACCOUNT_READER_ROUTES.search, search),
    );
    return reply.accounts;
  }

  async findUserIdByPlayerId(playerId: Player['id']): Promise<string | null> {
    const reply = AccountReaderWire.byPlayer.output.parse(
      await this.client.request('POST', ACCOUNT_READER_ROUTES.byPlayer, { playerId }),
    );
    return reply.userId;
  }

  private async fetch(
    ids: readonly string[],
    playEligibility?: boolean,
  ): Promise<Map<string, Account>> {
    if (ids.length === 0) {
      return new Map();
    }
    const batches = Array.from({ length: Math.ceil(ids.length / ACCOUNTS_BATCH_MAX) }, (_, i) =>
      ids.slice(i * ACCOUNTS_BATCH_MAX, (i + 1) * ACCOUNTS_BATCH_MAX),
    );
    const replies = await mapConcurrent(batches, BATCH_CONCURRENCY, async (batch) =>
      AccountReaderWire.accounts.output.parse(
        await this.client.request('POST', ACCOUNT_READER_ROUTES.accounts, {
          userIds: batch,
          playEligibility,
        }),
      ),
    );
    const requested = new Set(ids);
    const accounts = new Map<string, Account>();
    for (const account of replies.flatMap((reply) => reply.accounts)) {
      const key = account.userId.toLowerCase();
      if (requested.has(key)) {
        accounts.set(key, account);
        this.cache.set(key, account);
      }
    }
    return accounts;
  }
}

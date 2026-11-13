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
import { mapConcurrent, type InternalClient } from '@openora/core/server';

// How stale a role, status or exclusion may be on a read that does not ask for `fresh`.
export const ACCOUNT_CACHE_TTL_MS = 30_000;
// ponytail: per-process cache with oldest-first eviction; move it to the shared CACHE port if
// replicas multiply the identity load or need one view of a demotion.
const ACCOUNT_CACHE_MAX_ENTRIES = 10_000;
// Batches of one big read in flight at once, so a large roster does not queue them one by one.
const BATCH_CONCURRENCY = 4;

/**
 * {@link AccountReader} over the identity service's internal API. Each account found is kept
 * for {@link ACCOUNT_CACHE_TTL_MS}, unless the read asks for `fresh`; an unknown id is asked
 * again next time, so a new account shows at once. Any failed call throws, so a caller
 * deciding access refuses instead of treating an unreachable identity service as "no
 * restriction".
 */
export class RemoteAccountReader implements AccountReader {
  private readonly cache = new Map<string, { account: Account; expiresAt: number }>();
  // Cold reads in flight, by id, so concurrent reads of one id make one call. A fresh read
  // neither joins nor registers here; a miss is not remembered once the call settles.
  private readonly inFlight = new Map<string, Promise<Map<string, Account>>>();

  constructor(
    private readonly client: InternalClient,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccounts(
    userIds: readonly string[],
    options: AccountReadOptions = {},
  ): Promise<Map<string, Account>> {
    const now = this.now();
    const found = new Map<string, Account>();
    const joined = new Map<string, Promise<Map<string, Account>>>();
    const missing: string[] = [];
    for (const id of new Set(userIds.map((userId) => userId.toLowerCase()))) {
      const cached = options.fresh ? undefined : this.cache.get(id);
      const inFlight = options.fresh ? undefined : this.inFlight.get(id);
      if (cached && cached.expiresAt > now) {
        found.set(id, cached.account);
      } else if (inFlight) {
        joined.set(id, inFlight);
      } else {
        missing.push(id);
      }
    }
    const fetched = this.fetch(missing, now);
    if (!options.fresh) {
      for (const id of missing) {
        this.inFlight.set(id, fetched);
      }
    }
    try {
      for (const [id, account] of await fetched) {
        found.set(id, account);
      }
      for (const [id, pending] of joined) {
        const account = (await pending).get(id);
        if (account) {
          found.set(id, account);
        }
      }
    } finally {
      for (const id of missing) {
        if (this.inFlight.get(id) === fetched) {
          this.inFlight.delete(id);
        }
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

  /** Reads `ids` (lower case) in batches; caches and answers only the ids asked for. */
  private async fetch(ids: readonly string[], now: number): Promise<Map<string, Account>> {
    if (ids.length === 0) {
      return new Map();
    }
    const batches = Array.from({ length: Math.ceil(ids.length / ACCOUNTS_BATCH_MAX) }, (_, i) =>
      ids.slice(i * ACCOUNTS_BATCH_MAX, (i + 1) * ACCOUNTS_BATCH_MAX),
    );
    const replies = await mapConcurrent(batches, BATCH_CONCURRENCY, async (batch) =>
      AccountReaderWire.accounts.output.parse(
        await this.client.request('POST', ACCOUNT_READER_ROUTES.accounts, { userIds: batch }),
      ),
    );
    const requested = new Set(ids);
    const accounts = new Map<string, Account>();
    for (const account of replies.flatMap((reply) => reply.accounts)) {
      const key = account.userId.toLowerCase();
      if (requested.has(key)) {
        accounts.set(key, account);
        this.remember(key, account, now);
      }
    }
    return accounts;
  }

  private remember(key: string, account: Account, now: number) {
    this.cache.delete(key);
    this.cache.set(key, { account, expiresAt: now + ACCOUNT_CACHE_TTL_MS });
    if (this.cache.size > ACCOUNT_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
  }
}

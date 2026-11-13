import {
  ACCOUNT_READER_ROUTES,
  ACCOUNTS_BATCH_MAX,
  AccountReaderWire,
  type Account,
  type AccountReader,
  type Player,
  type PlayerSearch,
} from '@openora/core/contracts';
import type { InternalClient } from '@openora/core/server';

// How stale a role, status or play refusal may be on a service that reads accounts remotely.
export const ACCOUNT_CACHE_TTL_MS = 30_000;
// ponytail: per-process cache with oldest-first eviction; move it to the shared CACHE port if
// replicas multiply the identity load or need one view of a demotion.
const ACCOUNT_CACHE_MAX_ENTRIES = 10_000;

/**
 * {@link AccountReader} over the identity service's internal API. Each account found is kept
 * for {@link ACCOUNT_CACHE_TTL_MS}; an unknown id is asked again next time, so a new account
 * shows at once. Any failed call throws, so a caller deciding access refuses instead of
 * treating an unreachable identity service as "no restriction".
 */
export class RemoteAccountReader implements AccountReader {
  private readonly cache = new Map<string, { account: Account; expiresAt: number }>();

  constructor(
    private readonly client: InternalClient,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccounts(userIds: readonly string[]): Promise<Map<string, Account>> {
    const now = this.now();
    const found = new Map<string, Account>();
    const missing: string[] = [];
    for (const userId of new Set(userIds)) {
      const cached = this.cache.get(userId);
      if (cached && cached.expiresAt > now) {
        found.set(userId, cached.account);
      } else {
        missing.push(userId);
      }
    }
    for (let i = 0; i < missing.length; i += ACCOUNTS_BATCH_MAX) {
      const reply = AccountReaderWire.accounts.output.parse(
        await this.client.request('POST', ACCOUNT_READER_ROUTES.accounts, {
          userIds: missing.slice(i, i + ACCOUNTS_BATCH_MAX),
        }),
      );
      for (const account of reply.accounts) {
        found.set(account.userId, account);
        this.remember(account, now);
      }
    }
    return found;
  }

  async findPlayerByUsername(username: string): Promise<Account | null> {
    const reply = AccountReaderWire.byUsername.output.parse(
      await this.client.request('POST', ACCOUNT_READER_ROUTES.byUsername, { username }),
    );
    return reply.account;
  }

  async searchPlayers(search: PlayerSearch): Promise<Account[]> {
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

  private remember(account: Account, now: number) {
    this.cache.delete(account.userId);
    this.cache.set(account.userId, { account, expiresAt: now + ACCOUNT_CACHE_TTL_MS });
    if (this.cache.size > ACCOUNT_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
  }
}

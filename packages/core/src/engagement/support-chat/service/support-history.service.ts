import * as z from 'zod';
import { and, asc, eq, or } from 'drizzle-orm';
import { createDomainError, createLogger, type DrizzleService } from '@openora/core/server';
import {
  SupportHistoryItemSchema,
  SupportHistoryProviderError,
  type CacheAdapter,
  type SupportHistory,
  type SupportHistoryEmailWindow,
  type SupportHistoryItem,
  type SupportHistoryReader,
} from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { user, type User } from '@openora/core/pam/schema/identity';
import { player, type Player } from '@openora/core/pam/schema/profile';
import { supportChatCustomer } from '../schema/index.js';
import { SupportChatPlayerNotFoundError } from './support-chat.service.js';

const logger = createLogger('support-chat');

const HISTORY_CACHE_TTL_MS = 60_000;
const MAX_PREVIOUS_EMAILS = 3;

export const SupportHistoryNotConfiguredError = createDomainError<[]>(
  'SupportHistoryNotConfiguredError',
  () => 'Support history is not configured',
);

const STATUSES_OF: Record<SupportHistoryItem['kind'], ReadonlySet<SupportHistoryItem['status']>> = {
  ticket: new Set(['open', 'waiting', 'on_hold', 'solved', 'closed']),
  chat: new Set(['active', 'ended']),
};

const SupportHistoryItemsSchema = z.array(SupportHistoryItemSchema);

type EmailChange = { email: string | null; at: Date };

/**
 * The emails a player held and when, oldest first, the current one last and open-ended. Each
 * change (in the order it happened) ends the window of the email it replaced; a change without
 * that email ends the window before it without adding one. Only the most recent previous emails
 * are kept.
 */
export function buildEmailWindows({
  currentEmail,
  registeredAt,
  changes,
}: {
  currentEmail: User['email'];
  registeredAt: Date;
  changes: readonly EmailChange[];
}): SupportHistoryEmailWindow[] {
  const closed: SupportHistoryEmailWindow[] = [];
  let from = registeredAt;
  for (const change of changes) {
    if (change.email) {
      closed.push({ email: change.email, from: from.toISOString(), to: change.at.toISOString() });
    }
    from = change.at;
  }
  const previous = closed.slice(-MAX_PREVIOUS_EMAILS);
  return currentEmail
    ? [...previous, { email: currentEmail, from: from.toISOString(), to: null }]
    : previous;
}

// An adapter may throw anything, such as an HTTP client error holding the vendor API key or an
// email: only its class name survives.
const reasonOf = (err: unknown): string =>
  err instanceof SupportHistoryProviderError
    ? err.reason
    : `adapter threw ${err instanceof Error ? err.name : typeof err}`;

type Section = { state: 'ok' | 'unavailable'; items: SupportHistoryItem[] };

type SupportHistoryDeps = {
  drizzle: DrizzleService;
  cache: CacheAdapter;
  reader: SupportHistoryReader;
};

export class SupportHistoryService {
  constructor(private readonly deps: SupportHistoryDeps) {}

  /**
   * A player's vendor tickets and chat threads, cached whole per `(userId, includeResolved)` for
   * a minute, `fetchedAt` included. Each section fails on its own, its reason to the log only.
   */
  async getHistory(userId: User['id'], includeResolved: boolean): Promise<SupportHistory> {
    const key = `support-chat-history:${userId}:${includeResolved}`;
    // ponytail: no stampede lock - concurrent misses each reach the vendor; the per-admin rate
    // limit caps how many. Add a setIfAbsent lock if the vendor quota needs it.
    const cached = await this.deps.cache.get<SupportHistory>(key);
    if (cached !== undefined) {
      return cached;
    }
    const [row] = await this.deps.drizzle.db
      .select({
        email: user.email,
        registeredAt: user.createdAt,
        playerId: player.id,
        customerId: supportChatCustomer.providerCustomerId,
      })
      .from(user)
      .innerJoin(player, eq(player.userId, user.id))
      .leftJoin(supportChatCustomer, eq(supportChatCustomer.playerId, player.id))
      .where(eq(user.id, userId))
      .limit(1);
    if (!row) {
      throw new SupportChatPlayerNotFoundError(userId);
    }
    const windows = buildEmailWindows({
      currentEmail: row.email,
      registeredAt: row.registeredAt,
      changes: await this.emailChanges(userId, row.playerId),
    });
    const { customerId } = row;
    const [tickets, chats] = await Promise.all([
      windows.length === 0
        ? { state: 'no_email' as const, items: [] }
        : this.section(userId, 'ticket', () =>
            this.deps.reader.listTickets({ windows, includeResolved }),
          ),
      customerId === null
        ? { state: 'not_linked' as const, items: [] }
        : this.section(userId, 'chat', () => this.deps.reader.listChats({ customerId })),
    ]);
    const history: SupportHistory = { tickets, chats, fetchedAt: new Date().toISOString() };
    await this.deps.cache.set(key, history, { ttlMs: HISTORY_CACHE_TTL_MS });
    return history;
  }

  /**
   * The player's email changes from the audit log, in the order they were written. The audit
   * subscriber writes each row after the change commits (the event is not on the outbox), so a
   * lost event is a missing window: that email's tickets do not show.
   */
  private async emailChanges(userId: User['id'], playerId: Player['id']): Promise<EmailChange[]> {
    // The audit subject is the player when the account has one, the user otherwise.
    const rows = await this.deps.drizzle.db
      .select({ before: auditLog.before, at: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'identity.email.changed'),
          or(
            and(eq(auditLog.resourceType, 'player'), eq(auditLog.resourceId, playerId)),
            and(eq(auditLog.resourceType, 'user'), eq(auditLog.resourceId, userId)),
          ),
        ),
      )
      .orderBy(asc(auditLog.seq));
    return rows.map(({ before, at }) => {
      const email = before?.['email'];
      return { email: typeof email === 'string' ? email : null, at };
    });
  }

  private async section(
    userId: User['id'],
    kind: SupportHistoryItem['kind'],
    read: () => Promise<unknown>,
  ): Promise<Section> {
    const unavailable = (reason: string): Section => {
      logger.warn({ userId, section: kind, reason }, 'support history section unavailable');
      return { state: 'unavailable', items: [] };
    };
    let answer: unknown;
    try {
      answer = await read();
    } catch (err) {
      return unavailable(reasonOf(err));
    }
    const parsed = SupportHistoryItemsSchema.safeParse(answer);
    if (!parsed.success) {
      return unavailable('malformed answer');
    }
    const statuses = STATUSES_OF[kind];
    if (parsed.data.some((item) => item.kind !== kind || !statuses.has(item.status))) {
      return unavailable(`answered an item that is not a ${kind}`);
    }
    return {
      state: 'ok',
      items: parsed.data.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    };
  }
}

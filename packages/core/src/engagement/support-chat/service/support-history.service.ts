import * as z from 'zod';
import { and, asc, eq, or } from 'drizzle-orm';
import { cached, createDomainError, createLogger, type DrizzleService } from '@openora/core/server';
import {
  SUPPORT_CHAT_STATUSES,
  SUPPORT_TICKET_STATUSES,
  SupportHistoryItemSchema,
  SupportHistoryProviderError,
  type CacheAdapter,
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
  ticket: new Set(SUPPORT_TICKET_STATUSES),
  chat: new Set(SUPPORT_CHAT_STATUSES),
};

const SupportHistoryItemsSchema = z.array(SupportHistoryItemSchema);

type EmailChange = { before: string | null; after: string | null; at: Date };

/**
 * The emails a player held and when, oldest first, the current one last and open-ended. The
 * audit trail is trusted only when fully consistent: every change names both emails, each
 * replaced email is the previous change's new one, the changes run strictly forward in time from
 * registration, and the last new email is the current one. Anything else means an event was
 * lost, duplicated, reordered or mis-stamped, and no window is returned (`complete: false`), so a
 * player is shown no tickets rather than another player's. Nothing records the email an account
 * registered with, so a lost first change cannot be noticed. Only the most recent previous
 * emails are kept.
 */
export function buildEmailWindows({
  currentEmail,
  registeredAt,
  changes,
}: {
  currentEmail: User['email'];
  registeredAt: Date;
  changes: readonly EmailChange[];
}): { windows: SupportHistoryEmailWindow[]; complete: boolean } {
  const untrusted = { windows: [], complete: false };
  const closed: SupportHistoryEmailWindow[] = [];
  let from = registeredAt;
  let lastNewEmail: string | null = null;
  for (const { before, after, at } of changes) {
    if (!before || !after || at <= from || (lastNewEmail !== null && before !== lastNewEmail)) {
      return untrusted;
    }
    closed.push({ email: before, from: from.toISOString(), to: at.toISOString() });
    lastNewEmail = after;
    from = at;
  }
  if ((lastNewEmail ?? currentEmail) !== currentEmail) {
    return untrusted;
  }
  if (!currentEmail) {
    return { windows: [], complete: true };
  }
  const current = { email: currentEmail, from: from.toISOString(), to: null };
  return { windows: [...closed.slice(-MAX_PREVIOUS_EMAILS), current], complete: true };
}

// An adapter may throw anything, such as an HTTP client error holding the vendor API key or an
// email: only its class name survives.
const reasonOf = (err: unknown): string =>
  err instanceof SupportHistoryProviderError
    ? err.reason
    : `adapter threw ${err instanceof Error ? err.name : typeof err}`;

const emailOf = (side: Record<string, unknown> | null) =>
  typeof side?.['email'] === 'string' && side['email'] ? side['email'] : null;

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
  async getHistory(userId: User['id'], includeResolved: boolean) {
    // The audit log keeps ids as text, so an uppercase id would miss its rows and split the cache.
    const id = userId.toLowerCase();
    return cached(
      this.deps.cache,
      `support-chat-history:${id}:${includeResolved}`,
      HISTORY_CACHE_TTL_MS,
      () => this.load(id, includeResolved),
    );
  }

  private async load(userId: User['id'], includeResolved: boolean) {
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
    const { windows, complete } = buildEmailWindows({
      currentEmail: row.email,
      registeredAt: row.registeredAt,
      changes: await this.emailChanges(userId, row.playerId),
    });
    if (!complete) {
      logger.warn(
        { userId },
        'support history email windows dropped - email change trail has a gap',
      );
    }
    const { customerId } = row;
    const [tickets, chats] = await Promise.all([
      windows.length === 0
        ? { state: complete ? ('no_email' as const) : ('unavailable' as const), items: [] }
        : this.section(userId, 'ticket', () =>
            this.deps.reader.listTickets({ windows, includeResolved }),
          ),
      customerId === null
        ? { state: 'not_linked' as const, items: [] }
        : this.section(userId, 'chat', () => this.deps.reader.listChats({ customerId })),
    ]);
    return { tickets, chats, fetchedAt: new Date().toISOString() };
  }

  /**
   * The player's email changes from the audit log, in the order they were written. The audit
   * subscriber writes each row shortly after its change (the event is not on the outbox), so a
   * row can be lost or land out of order; `buildEmailWindows` drops what that leaves unknown.
   */
  private async emailChanges(userId: User['id'], playerId: Player['id']) {
    // The audit subject is the player when the account has one, the user otherwise.
    const rows = await this.deps.drizzle.db
      .select({ before: auditLog.before, after: auditLog.after, at: auditLog.createdAt })
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
    return rows.map(
      ({ before, after, at }): EmailChange => ({
        before: emailOf(before),
        after: emailOf(after),
        at,
      }),
    );
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

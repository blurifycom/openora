import * as z from 'zod';
import { and, asc, eq, or } from 'drizzle-orm';
import { cached, createDomainError, createLogger, type DrizzleService } from '@openora/core/server';
import {
  TimestampSchema,
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

// `timedByChange` when `at` is the change time the event carried, not the row's write time.
type EmailChange = {
  before: string | null;
  after: string | null;
  at: Date;
  timedByChange: boolean;
};

// A redelivered event writes its row again, wherever it lands: the same emails and the same
// carried change time as an earlier row. The first stays in place and the repeats are dropped. A
// row timed by its write time cannot be told from a real repeat, so it is never dropped.
function withoutRedeliveries(changes: readonly EmailChange[]) {
  const seen = new Set<string>();
  return changes.filter((change) => {
    if (!change.timedByChange) {
      return true;
    }
    const key = JSON.stringify([change.before, change.after, change.at.getTime()]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * The emails a player held and when, oldest first, the current one last and open-ended. The
 * audit trail is trusted from its end back to its first break: walking back from the current
 * email, each change must name the email the next one replaced (the last change the current
 * email) and run strictly after the change before it, or after registration for the first one. A
 * break means an event was lost, duplicated, reordered or mis-stamped: everything before it is
 * dropped, together with the window starting at a change whose time is out of order, so no window
 * is wider than the truth. When the current email itself cannot be trusted there is no window at
 * all, until the next email change. `complete` is false when a break or the cap on previous emails
 * left an older email out; `broken` tells a break from the cap. Nothing records the email an
 * account registered with, so a lost first change cannot be noticed. A row repeating an earlier
 * one, change time included, is a redelivery and counts once.
 */
export function buildEmailWindows({
  currentEmail,
  registeredAt,
  changes,
}: {
  currentEmail: User['email'];
  registeredAt: Date;
  changes: readonly EmailChange[];
}): { windows: SupportHistoryEmailWindow[]; complete: boolean; broken: boolean } {
  const rows = withoutRedeliveries(changes);
  // Newest first while walking back.
  const found: SupportHistoryEmailWindow[] = [];
  const done = (broken: boolean) => ({
    windows: found.slice(0, MAX_PREVIOUS_EMAILS + 1).reverse(),
    complete: !broken && found.length <= MAX_PREVIOUS_EMAILS + 1,
    broken,
  });
  if (!currentEmail) {
    return done(rows.length > 0);
  }
  let email = currentEmail;
  let to: Date | null = null;
  for (const [k, { before, after, at }] of [...rows.entries()].reverse()) {
    if (after !== email || at <= (rows[k - 1]?.at ?? registeredAt)) {
      return done(true);
    }
    found.push({ email, from: at.toISOString(), to: to?.toISOString() ?? null });
    if (!before) {
      return done(true);
    }
    email = before;
    to = at;
  }
  found.push({ email, from: registeredAt.toISOString(), to: to?.toISOString() ?? null });
  return done(false);
}

// An adapter may throw anything, such as an HTTP client error holding the vendor API key or an
// email: only its class name survives.
const reasonOf = (err: unknown): string =>
  err instanceof SupportHistoryProviderError
    ? err.reason
    : `adapter threw ${err instanceof Error ? err.name : typeof err}`;

// The change time the event carried, when it is a valid timestamp; rows from before it fall back
// to their write time.
const changedAtOf = (after: Record<string, unknown> | null) => {
  const parsed = TimestampSchema.safeParse(after?.['changedAt']);
  return parsed.success ? new Date(parsed.data) : null;
};

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
    const { windows, complete, broken } = buildEmailWindows({
      currentEmail: row.email,
      registeredAt: row.registeredAt,
      changes: await this.emailChanges(userId, row.playerId),
    });
    if (broken) {
      logger.warn(
        { userId },
        'support history email trail inconsistent - older emails not searched',
      );
    }
    const { customerId } = row;
    const [tickets, chats] = await Promise.all([
      windows.length === 0
        ? {
            state: broken ? ('unavailable' as const) : ('no_email' as const),
            items: [],
            complete: !broken,
          }
        : this.section(userId, 'ticket', () =>
            this.deps.reader.listTickets({ windows, includeResolved }),
          ).then((section) => ({ ...section, complete: section.state === 'ok' && complete })),
      customerId === null
        ? { state: 'not_linked' as const, items: [] }
        : this.section(userId, 'chat', () => this.deps.reader.listChats({ customerId })),
    ]);
    return { tickets, chats, fetchedAt: new Date().toISOString() };
  }

  /**
   * The player's email changes from the audit log, in the order they were written, each timed by
   * the change the event carried. The audit subscriber writes each row after its change (the
   * event is not on the outbox), so a row can be lost or land out of order; `buildEmailWindows`
   * then trusts only the rows after the last break.
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
    return rows.map(({ before, after, at }): EmailChange => {
      const changedAt = changedAtOf(after);
      return {
        before: emailOf(before),
        after: emailOf(after),
        at: changedAt ?? at,
        timedByChange: changedAt !== null,
      };
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

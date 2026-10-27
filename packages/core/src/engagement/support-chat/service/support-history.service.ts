import * as z from 'zod';
import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import { cached, createDomainError, createLogger, type DrizzleService } from '@openora/core/server';
import {
  TimestampSchema,
  SUPPORT_CHAT_STATUSES,
  SUPPORT_TICKET_STATUSES,
  SupportHistoryFailureReasonSchema,
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
// How far the clock stamping a change may run ahead of the one stamping its audit row.
const MAX_CLOCK_SKEW_MS = 5_000;

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
  // When the audit row was written, which always follows the change.
  writtenAt: Date;
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
 * The emails a player held and when, oldest first, the current one last and open-ended. The audit
 * trail is trusted from its end back to its first break, walking back from the current email: each
 * change must name as its new email the one the next change replaced (the last change the current
 * email), and its time must be later than every earlier change and registration, and not later than
 * its own audit write allowing for clock skew. A change claiming a time ahead of the real clock
 * thus breaks every later one until real time passes it. Everything from the first break walking
 * back is dropped, the window opened by a change with a wrong time included. When even the last
 * change cannot be trusted there is no window at all. `complete` is false when a break or the cap
 * on previous emails left an older email out; `broken` tells a break from the cap. A row repeating
 * an earlier one, change time included, is a redelivery and counts once. The oldest window of an
 * intact trail is only assumed to start at registration; `boundFirstWindow` checks it against other
 * accounts. Nothing in the trail can notice a lost first change, a lost run returning to the
 * address it left, a time later than the real change by no more than its audit write's own delay
 * plus the skew (a fast clock with a delayed or redelivered write, or a legacy row timed by its
 * write), which widens the earlier email's window by that much, or a clock running behind whose
 * stamps still follow every earlier one, which shifts the bounds by the lag.
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
  if (!currentEmail) {
    return { windows: [], complete: rows.length === 0, broken: rows.length > 0 };
  }
  // floors[k]: the latest time stamped before row k, registration included.
  const floors: number[] = [];
  let latest = registeredAt.getTime();
  for (const { at } of rows) {
    floors.push(latest);
    latest = Math.max(latest, at.getTime());
  }
  // Newest first while walking back.
  const found: SupportHistoryEmailWindow[] = [];
  let email = currentEmail;
  let to: string | null = null;
  let broken = false;
  for (let k = rows.length - 1; k >= 0; k--) {
    const { before, after, at, writtenAt } = rows[k];
    const wrongTime =
      at.getTime() <= floors[k] || at.getTime() > writtenAt.getTime() + MAX_CLOCK_SKEW_MS;
    if (after !== email || wrongTime) {
      broken = true;
      break;
    }
    found.push({ email, from: at.toISOString(), to });
    if (!before) {
      broken = true;
      break;
    }
    email = before;
    to = at.toISOString();
  }
  if (!broken) {
    found.push({ email, from: registeredAt.toISOString(), to });
  }
  return {
    windows: found.slice(0, MAX_PREVIOUS_EMAILS + 1).reverse(),
    complete: !broken && found.length <= MAX_PREVIOUS_EMAILS + 1,
    broken,
  };
}

/**
 * Checks the one window `buildEmailWindows` only assumes: the oldest of a complete trail, opened
 * at registration. A lost first change would leave the player's later email held from
 * registration, over the time another account held it. `others` are other accounts' changes
 * naming that email, compared case-insensitively. The latest one strictly after registration and
 * before the window closes decides: another account leaving the address opens the window then,
 * and another account taking it drops the window, as nothing places when that account let it go.
 * Either way the trail is reported broken. An incomplete result, which has no registration window,
 * is returned as it is.
 */
export function boundFirstWindow(
  built: ReturnType<typeof buildEmailWindows>,
  registeredAt: Date,
  others: readonly Pick<EmailChange, 'before' | 'after' | 'at'>[],
): ReturnType<typeof buildEmailWindows> {
  const [first, ...rest] = built.windows;
  if (!built.complete || !first) {
    return built;
  }
  const email = first.email.toLowerCase();
  const until = first.to === null ? Infinity : Date.parse(first.to);
  let latest: { at: Date; took: boolean } | null = null;
  for (const { before, after, at } of others) {
    const took = after?.toLowerCase() === email;
    const inside = at.getTime() > registeredAt.getTime() && at.getTime() < until;
    // A tie goes to the account taking the address, which fails closed.
    if (
      inside &&
      (took || before?.toLowerCase() === email) &&
      (!latest || at > latest.at || (at.getTime() === latest.at.getTime() && took))
    ) {
      latest = { at, took };
    }
  }
  if (!latest) {
    return built;
  }
  return {
    windows: latest.took ? rest : [{ ...first, from: latest.at.toISOString() }, ...rest],
    complete: false,
    broken: true,
  };
}

// An adapter may throw anything, such as an HTTP client error holding the vendor API key or an
// email: only its class name survives. A provider error keeps its reason only when it is a listed
// code, since a JavaScript adapter can pass any text.
const reasonOf = (err: unknown): string => {
  if (!(err instanceof SupportHistoryProviderError)) {
    return `adapter threw ${err instanceof Error ? err.name : typeof err}`;
  }
  return SupportHistoryFailureReasonSchema.safeParse(err.reason).success
    ? err.reason
    : 'unlisted reason';
};

// The change time the event carried, when it is a valid timestamp; rows from before it fall back
// to their write time.
const changedAtOf = (after: Record<string, unknown> | null) => {
  const parsed = TimestampSchema.safeParse(after?.['changedAt']);
  return parsed.success ? new Date(parsed.data) : null;
};

const emailOf = (side: Record<string, unknown> | null) =>
  typeof side?.['email'] === 'string' && side['email'] ? side['email'] : null;

const toEmailChange = ({
  before,
  after,
  at,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: Date;
}): EmailChange => {
  const changedAt = changedAtOf(after);
  return {
    before: emailOf(before),
    after: emailOf(after),
    at: changedAt ?? at,
    writtenAt: at,
    timedByChange: changedAt !== null,
  };
};

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
    const built = buildEmailWindows({
      currentEmail: row.email,
      registeredAt: row.registeredAt,
      changes: await this.emailChanges(userId, row.playerId),
    });
    const first = built.complete ? built.windows[0] : undefined;
    const { windows, complete, broken } = boundFirstWindow(
      built,
      row.registeredAt,
      first ? await this.othersEmailChanges(first.email, userId, row.playerId) : [],
    );
    if (broken) {
      logger.warn({ userId }, 'support history email trail inconsistent');
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
   * then drops everything from the first break walking back.
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
    return rows.map(toEmailChange);
  }

  /**
   * Email changes of every other account that left or took `email`, case-insensitively, timed
   * like the player's own. The player's own rows, under either subject, are left out.
   */
  private async othersEmailChanges(email: string, userId: User['id'], playerId: Player['id']) {
    // ponytail: the action index narrows to email-change rows and the email match scans them; an
    // expression index on lower(before->>'email') and lower(after->>'email') when that grows.
    const rows = await this.deps.drizzle.db
      .select({ before: auditLog.before, after: auditLog.after, at: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'identity.email.changed'),
          or(
            sql`lower(${auditLog.before}->>'email') = lower(${email})`,
            sql`lower(${auditLog.after}->>'email') = lower(${email})`,
          ),
          // Defense in depth: the player's own rows of a complete trail fall at or after the oldest
          // window's `to` and are ignored anyway. Both clauses stay, since excluding by subject
          // type alone would drop other accounts.
          or(ne(auditLog.resourceType, 'player'), ne(auditLog.resourceId, playerId)),
          or(ne(auditLog.resourceType, 'user'), ne(auditLog.resourceId, userId)),
        ),
      );
    return rows.map(toEmailChange);
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

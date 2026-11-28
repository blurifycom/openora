import * as z from 'zod';
import { eq } from 'drizzle-orm';
import {
  cached,
  createDomainError,
  createLogger,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import {
  TimestampSchema,
  SUPPORT_CHAT_STATUSES,
  SUPPORT_TICKET_STATUSES,
  SupportHistoryItemSchema,
  type AuditEmailChange,
  type AuditReader,
  type CacheAdapter,
  type SupportHistoryEmailWindow,
  type SupportHistoryItem,
  type SupportHistoryReader,
} from '@openora/core/contracts';
import { user, type User } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { supportChatCustomer } from '../schema/index.js';
import { reasonOf, type ProviderFailureReason } from './provider-reason.service.js';
import { SupportChatPlayerNotFoundError } from './support-chat.service.js';

const logger = createLogger('support-chat');

const HISTORY_CACHE_TTL_MS = 60_000;
const MAX_PREVIOUS_EMAILS = 3;
const MAX_CLOCK_SKEW_MS = 5_000;

export const SupportHistoryNotConfiguredError = createDomainError<[]>(
  'SupportHistoryNotConfiguredError',
  () => 'Support history is not configured',
  { reason: 'not_configured' },
);

const STATUSES_OF: Record<SupportHistoryItem['kind'], ReadonlySet<SupportHistoryItem['status']>> = {
  ticket: new Set(SUPPORT_TICKET_STATUSES),
  chat: new Set(SUPPORT_CHAT_STATUSES),
};

const SupportHistoryItemsSchema = z.array(SupportHistoryItemSchema);

type EmailChange = {
  before: string | null;
  after: string | null;
  at: Date;
  writtenAt: Date;
  timedByChange: boolean;
};

export function withoutRedeliveries(changes: readonly EmailChange[]) {
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

export function buildEmailWindows({
  currentEmail,
  registeredEmail,
  registeredAt,
  changes,
}: {
  currentEmail: User['email'];
  registeredEmail: User['registeredEmail'];
  registeredAt: Date;
  changes: readonly EmailChange[];
}): { windows: SupportHistoryEmailWindow[]; complete: boolean; broken: boolean } {
  const rows = withoutRedeliveries(changes);
  if (!currentEmail) {
    return { windows: [], complete: rows.length === 0, broken: rows.length > 0 };
  }
  const floors: number[] = [];
  let latest = registeredAt.getTime();
  for (const { at } of rows) {
    floors.push(latest);
    latest = Math.max(latest, at.getTime());
  }
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
  if (!broken && registeredEmail && registeredEmail.toLowerCase() !== email.toLowerCase()) {
    broken = true;
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

const changedAtOf = (after: Record<string, unknown> | null) => {
  const parsed = TimestampSchema.safeParse(after?.['changedAt']);
  return parsed.success ? new Date(parsed.data) : null;
};

const emailOf = (side: Record<string, unknown> | null) =>
  typeof side?.['email'] === 'string' && side['email'] ? side['email'] : null;

const toEmailChange = ({ before, after, at }: AuditEmailChange): EmailChange => {
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
  audit: AuditReader;
};

export class SupportHistoryService {
  constructor(private readonly deps: SupportHistoryDeps) {}

  async getHistory(userId: User['id'], includeResolved: boolean) {
    const id = userId.toLowerCase();
    let lagging = false;
    return cached(
      this.deps.cache,
      `support-chat-history:v2:${id}:${includeResolved}`,
      HISTORY_CACHE_TTL_MS,
      async () => {
        const { lagging: lags, ...history } = await this.load(id, includeResolved);
        lagging = lags;
        return history;
      },
      () => !lagging,
    );
  }

  private async load(userId: User['id'], includeResolved: boolean) {
    const { customerId, windows, complete, broken, queued } =
      await this.deps.drizzle.db.transaction((tx) => this.readEmailTrail(tx, userId), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    if (broken) {
      logger.warn({ userId }, 'support history email trail inconsistent');
    }
    const [tickets, chats] = await Promise.all([
      windows.length === 0
        ? {
            state: broken ? ('email_gap' as const) : ('no_email' as const),
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
    return {
      tickets,
      chats,
      fetchedAt: new Date().toISOString(),
      lagging: queued && (!complete || broken),
    };
  }

  private async readEmailTrail(tx: DrizzleTx, userId: User['id']) {
    const [row] = await tx
      .select({
        email: user.email,
        registeredEmail: user.registeredEmail,
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
    const subject = { playerId: row.playerId, userId };
    const changes = await this.deps.audit.emailChanges(subject, tx);
    const built = buildEmailWindows({
      currentEmail: row.email,
      registeredEmail: row.registeredEmail,
      registeredAt: row.registeredAt,
      changes: changes.map(toEmailChange),
    });
    const first = built.complete ? built.windows[0] : undefined;
    const others = first
      ? await this.deps.audit.othersEmailChanges({ ...subject, email: first.email }, tx)
      : [];
    const bounded = boundFirstWindow(built, row.registeredAt, others.map(toEmailChange));
    const queued = [...changes, ...others].some((change) => change.queued);
    return { customerId: row.customerId, queued, ...bounded };
  }

  private async section(
    userId: User['id'],
    kind: SupportHistoryItem['kind'],
    read: () => Promise<unknown>,
  ): Promise<Section> {
    const unavailable = (
      reason:
        | ProviderFailureReason
        | 'malformed answer'
        | `answered an item that is not a ${SupportHistoryItem['kind']}`,
    ): Section => {
      logger.warn({ userId, section: kind, reason }, 'support history section unavailable');
      return { state: 'unavailable', items: [] };
    };
    let answer: unknown;
    try {
      answer = await read();
    } catch (err) {
      return unavailable(reasonOf(err));
    }
    let parsed: ReturnType<typeof SupportHistoryItemsSchema.safeParse>;
    try {
      parsed = SupportHistoryItemsSchema.safeParse(answer);
    } catch {
      return unavailable('malformed answer');
    }
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

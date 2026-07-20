import type { RealtimePresence, RealtimeTransport } from '@openora/core/contracts';
import type { createLogger } from '@openora/core/server';

export type AblyPresencePage = {
  items: { clientId?: string }[];
  hasNext(): boolean;
  next(): Promise<AblyPresencePage | null>;
};

export type AblyChannelClient = {
  publish(name: string, data: unknown): Promise<unknown>;
  presence: { get(): Promise<AblyPresencePage> };
};

export type AblyRealtimeClient = {
  channels: { get(channel: string): AblyChannelClient };
};

export type AblyLogger = Pick<ReturnType<typeof createLogger>, 'warn'>;

async function presenceClientIds(page: AblyPresencePage): Promise<string[]> {
  const current = page.items.flatMap(({ clientId }) => (clientId ? [clientId] : []));
  const next = page.hasNext() ? await page.next() : null;
  return next ? [...current, ...(await presenceClientIds(next))] : current;
}

class AblyRealtimePresence implements RealtimePresence {
  constructor(
    private readonly rest: AblyRealtimeClient,
    private readonly log: AblyLogger,
  ) {}

  join(_channel: string, _memberId: string, _connectionId: string) {}

  leave(_channel: string, _memberId: string, _connectionId: string) {}

  async count(channel: string) {
    try {
      return new Set(await presenceClientIds(await this.rest.channels.get(channel).presence.get()))
        .size;
    } catch (err) {
      this.log.warn({ err, channel }, 'Ably presence count failed - returning zero.');
      return 0;
    }
  }
}

/** Server-to-Ably fan-out. Browser subscriptions connect directly to Ably. */
export class AblyRealtimeTransport implements RealtimeTransport {
  readonly presence: RealtimePresence;

  constructor(
    private readonly rest: AblyRealtimeClient,
    private readonly log: AblyLogger,
  ) {
    this.presence = new AblyRealtimePresence(rest, log);
  }

  async publish<T>(channel: string, event: T) {
    try {
      await this.rest.channels.get(channel).publish('message', event);
    } catch (err) {
      this.log.warn({ err, channel }, 'Ably publish failed - live push skipped.');
    }
  }

  subscribe<T>(_channel: string, _handler: (event: T) => void) {
    return () => {};
  }
}

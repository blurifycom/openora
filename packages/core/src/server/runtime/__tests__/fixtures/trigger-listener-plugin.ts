import type { EventEnvelope, TokenCatalog, TriggerDescriptor } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export type HeardTrigger = {
  trigger: TriggerDescriptor;
  payload: unknown;
  envelope: EventEnvelope;
};

/** What the listener heard, on globalThis: the host imports this file by path, not the test. */
export function heardTriggers(): HeardTrigger[] {
  const holder = globalThis as { __heardTriggers?: HeardTrigger[] };
  holder.__heardTriggers ??= [];
  return holder.__heardTriggers;
}

export default {
  id: 'trigger-listener',
  register(ctx) {
    ctx.triggers.listen((trigger, payload, envelope) => {
      heardTriggers().push({ trigger, payload, envelope });
    });
  },
} satisfies Plugin<TokenCatalog>;

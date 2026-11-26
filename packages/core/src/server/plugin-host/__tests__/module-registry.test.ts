import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { queue } from '@openora/core/contracts';
import { Container } from '../../kernel/index.js';
import { ModuleRegistryImpl } from '../module-registry.js';

const worker = (name: string) => ({
  queue: queue(name),
  schema: z.object({}),
  handler: async () => {},
});

describe('a required-only module', () => {
  it('withholds what it would consume and keeps the rest', () => {
    const reg = new ModuleRegistryImpl(new Container());
    const consumed = () => {};
    reg.requireOnly('identity');

    reg.setOwner('identity');
    reg.events.on('wallet.deposit.completed', () => {});
    reg.triggers.listen(() => {});
    reg.jobs.worker(worker('identity-job'));
    reg.setOwner('chat');
    reg.events.on('wallet.deposit.completed', consumed);
    reg.jobs.worker(worker('chat-job'));
    reg.setOwner(null);

    expect(reg.events.getAll().get('wallet.deposit.completed')).toEqual([
      { handler: consumed, consumer: 'chat/wallet.deposit.completed' },
    ]);
    expect(reg.triggers.getAll()).toEqual([]);
    expect(reg.jobs.getAll().map((w) => w.queue)).toEqual(['chat-job']);
    expect(reg.withheld()).toEqual([
      { owner: 'identity', kind: 'event', name: 'wallet.deposit.completed' },
      { owner: 'identity', kind: 'trigger', name: 'agent triggers' },
      { owner: 'identity', kind: 'job', name: 'identity-job' },
    ]);
  });
});

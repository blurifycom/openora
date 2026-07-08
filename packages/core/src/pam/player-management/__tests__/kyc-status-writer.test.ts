import { describe, it, expect, vi } from 'vitest';
import type { EventBus } from '@openora/core/server';
import { PlayerKycStatusWriter } from '../service/kyc-status-writer.js';
import { mock, mockDb } from '../../../testing/mock.js';

function makeDb(selectResult: unknown) {
  const builder: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown) => res(selectResult);
      return () => builder;
    },
    apply: () => builder,
  });
  return mockDb(builder);
}

function makeWriter(selectResult: unknown) {
  const events = { emit: vi.fn(), on: vi.fn() };
  const writer = new PlayerKycStatusWriter(makeDb(selectResult), mock<EventBus>(events));
  return { writer, events };
}

describe('PlayerKycStatusWriter.setStatus', () => {
  it('writes player.kycStatus and emits compliance.kyc.updated on a real change', async () => {
    const { writer, events } = makeWriter([{ kycStatus: 'pending' }]);
    await writer.setStatus('u-1', 'verified', { actorId: 'admin-1', source: 'manual' });
    expect(events.emit).toHaveBeenCalledWith('compliance.kyc.updated', {
      userId: 'u-1',
      actorId: 'admin-1',
      status: 'verified',
      previousStatus: 'pending',
    });
  });

  it('is a no-op when the status is unchanged', async () => {
    const { writer, events } = makeWriter([{ kycStatus: 'verified' }]);
    await writer.setStatus('u-1', 'verified', { actorId: null, source: 'vendor' });
    expect(events.emit).not.toHaveBeenCalled();
  });
});

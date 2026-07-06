import { describe, it, expect, vi } from 'vitest';
import type { EventBus } from '@blurifycom/core/server';
import type { PlayerTagWithTag } from '../contract/index.js';
import {
  TagService,
  TagAlreadyInUseError,
  TagAssignmentNotFoundError,
  TagNotFoundError,
} from '../service/tag.service.js';
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

function makeService(playerRow: unknown) {
  const events = { emit: vi.fn(), on: vi.fn() };
  const svc = new TagService(makeDb(playerRow), mock<EventBus>(events));
  const assign = vi.spyOn(svc, 'assignPlayerTag').mockResolvedValue(mock<PlayerTagWithTag>({}));
  const remove = vi.spyOn(svc, 'removePlayerTag').mockResolvedValue(mock<PlayerTagWithTag>({}));
  return { svc, assign, remove };
}

describe('TagService.syncKycStatusTags', () => {
  it('adds kyc_pending and clears kyc_rejected when status is pending', async () => {
    const { svc, assign, remove } = makeService([{ id: 'p-1' }]);
    await svc.syncKycStatusTags({ userId: 'u-1', actorId: 'a-1', status: 'pending' });
    expect(assign).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 'p-1', tagKey: 'kyc_pending', assignActor: 'scheduled' }),
    );
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 'p-1', tagKey: 'kyc_rejected' }),
    );
  });

  it('adds kyc_rejected and clears kyc_pending when status is rejected', async () => {
    const { svc, assign, remove } = makeService([{ id: 'p-1' }]);
    await svc.syncKycStatusTags({ userId: 'u-1', actorId: 'a-1', status: 'rejected' });
    expect(assign).toHaveBeenCalledWith(expect.objectContaining({ tagKey: 'kyc_rejected' }));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ tagKey: 'kyc_pending' }));
  });

  it('clears both triage tags when status is neither pending nor rejected', async () => {
    const { svc, assign, remove } = makeService([{ id: 'p-1' }]);
    await svc.syncKycStatusTags({ userId: 'u-1', actorId: 'a-1', status: 'verified' });
    expect(assign).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ tagKey: 'kyc_pending' }));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ tagKey: 'kyc_rejected' }));
  });

  it('no-ops when no player matches the userId', async () => {
    const { svc, assign, remove } = makeService([]);
    await svc.syncKycStatusTags({ userId: 'nope', actorId: 'a-1', status: 'pending' });
    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('is idempotent: swallows a re-add of an already-present tag', async () => {
    const { svc, assign } = makeService([{ id: 'p-1' }]);
    assign.mockRejectedValueOnce(new TagAlreadyInUseError());
    await expect(
      svc.syncKycStatusTags({ userId: 'u-1', actorId: 'a-1', status: 'pending' }),
    ).resolves.toBeUndefined();
  });

  it('is idempotent: swallows a removal of an absent tag', async () => {
    const { svc, remove } = makeService([{ id: 'p-1' }]);
    remove.mockRejectedValue(new TagAssignmentNotFoundError('p-1'));
    await expect(
      svc.syncKycStatusTags({ userId: 'u-1', actorId: 'a-1', status: 'verified' }),
    ).resolves.toBeUndefined();
  });

  it('tolerates an unseeded tag definition when clearing (TagNotFoundError)', async () => {
    const { svc, remove } = makeService([{ id: 'p-1' }]);
    remove.mockRejectedValue(new TagNotFoundError('kyc_pending'));
    await expect(
      svc.syncKycStatusTags({ userId: 'u-1', actorId: 'a-1', status: 'verified' }),
    ).resolves.toBeUndefined();
  });
});

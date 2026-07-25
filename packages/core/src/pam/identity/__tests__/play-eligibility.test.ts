import { describe, it, expect } from 'vitest';
import { makeDrizzle } from '../../../testing/mock.js';
import { PlayEligibilityService } from '../service/play-eligibility.service.js';

const HOUR_MS = 60 * 60 * 1000;

function serviceFor(rows: Record<string, unknown>[]) {
  return new PlayEligibilityService(makeDrizzle({ select: [rows] }));
}

describe('PlayEligibilityService', () => {
  it('reports an indefinitely blocked player as restricted', async () => {
    const svc = serviceFor([{ rgBlocked: true, rgBlockedUntil: null }]);

    await expect(svc.isRestricted('user-1')).resolves.toBe(true);
  });

  it('reports a cooling-off still in its window as restricted', async () => {
    const svc = serviceFor([{ rgBlocked: true, rgBlockedUntil: new Date(Date.now() + HOUR_MS) }]);

    await expect(svc.isRestricted('user-1')).resolves.toBe(true);
  });

  it('reports an elapsed cooling-off as unrestricted before the expiry sweep runs', async () => {
    const svc = serviceFor([{ rgBlocked: true, rgBlockedUntil: new Date(Date.now() - HOUR_MS) }]);

    await expect(svc.isRestricted('user-1')).resolves.toBe(false);
  });

  it('reports an unblocked player as unrestricted', async () => {
    const svc = serviceFor([{ rgBlocked: false, rgBlockedUntil: null }]);

    await expect(svc.isRestricted('user-1')).resolves.toBe(false);
  });

  it('fails closed for an unknown user', async () => {
    const svc = serviceFor([]);

    await expect(svc.isRestricted('ghost')).resolves.toBe(true);
  });
});

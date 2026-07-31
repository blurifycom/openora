import { describe, it, expect, vi } from 'vitest';
import { call } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { mock, testContext, adminCaller } from '../../testing/mock.js';
import { createIamRouter } from '../router/index.js';
import type { IamService } from '../service/iam.service.js';

const CTX = testContext();

describe('iam router - reportAccessDenied', () => {
  it('asserts a plain admin session, then delegates to AdminGuard.recordDeniedAccess', async () => {
    const caller = adminCaller();
    const recordDeniedAccess = vi.fn().mockResolvedValue({ recorded: true });
    const assert = vi.fn().mockResolvedValue(caller);
    const adminGuard = mock<AdminGuard>({ assert, recordDeniedAccess });
    const router = createIamRouter(mock<IamService>({}), adminGuard);

    const result = await call(
      router.reportAccessDenied,
      { resource: 'game', level: 'read' },
      { context: CTX },
    );

    expect(result).toEqual({ recorded: true });
    expect(assert).toHaveBeenCalledWith(CTX);
    expect(recordDeniedAccess).toHaveBeenCalledWith(caller, 'game', 'read');
  });
});

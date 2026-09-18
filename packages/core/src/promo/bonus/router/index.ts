import { implement } from '@orpc/server';
import { getUserId, mapErrors, type OssContext } from '@openora/core/server';
import { bonusContract } from '../contract/index.js';
import { GrantNotFoundError, GrantReaderService } from '../service/grant-reader.service.js';

export function createBonusRouter(grants: GrantReaderService) {
  const os = implement(bonusContract).$context<OssContext>();

  return os.router({
    grants: {
      list: os.grants.list.handler(({ input, context }) =>
        grants.list(getUserId(context), input.status),
      ),

      get: os.grants.get.handler(({ input, context }) =>
        mapErrors({ NOT_FOUND: GrantNotFoundError }, () =>
          grants.get(getUserId(context), input.id),
        ),
      ),
    },
  });
}

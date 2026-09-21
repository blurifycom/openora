import { implement } from '@orpc/server';
import { getUserId, mapErrors, type OssContext } from '@openora/core/server';
import { gamificationContract } from '../contract/index.js';
import { RankLadderNotConfiguredError, RankService } from '../service/rank.service.js';

export function createGamificationRouter({ ranks }: { ranks: RankService }) {
  const os = implement(gamificationContract).$context<OssContext>();

  return os.router({
    ranks: {
      get: os.ranks.get.handler(({ context }) =>
        mapErrors({ NOT_FOUND: RankLadderNotConfiguredError }, () =>
          ranks.getForPlayer(getUserId(context)),
        ),
      ),
    },
  });
}

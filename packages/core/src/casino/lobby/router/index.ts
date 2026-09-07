import { implement } from '@orpc/server';
import { mapErrors, type AdminGuard, type OssContext } from '@openora/core/server';
import { lobbyAdminContract, lobbyContract } from '../contract/index.js';
import {
  LobbyService,
  LobbyLayoutVersionConflictError,
  LobbySectionFieldError,
  LobbySectionNotFoundError,
} from '../service/lobby.service.js';

const NOT_FOUND = [LobbySectionNotFoundError];
const BAD_REQUEST = [LobbySectionFieldError];

export function createLobbyRouter({
  lobby,
  adminGuard,
}: {
  lobby: LobbyService;
  adminGuard: AdminGuard;
}) {
  const os = implement({ ...lobbyContract, ...lobbyAdminContract }).$context<OssContext>();

  return os.router({
    getLayout: os.getLayout.handler(() => lobby.getLayout()),

    getAdminLayout: os.getAdminLayout.handler(async ({ context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return lobby.getAdminLayout();
    }),

    replaceLayout: os.replaceLayout.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors({ NOT_FOUND, BAD_REQUEST, CONFLICT: LobbyLayoutVersionConflictError }, () =>
        lobby.replaceLayout({ ...input, actorId: userId, ip, userAgent }),
      );
    }),
  });
}

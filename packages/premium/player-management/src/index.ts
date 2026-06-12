// Public surface of the player-management premium package (admin PAM).
export { PlayerService, PlayerNotFoundError } from './service/player.service.js';
export { createPlayerRouter } from './router/index.js';
export { default as playerManagementPlugin } from './plugin.js';

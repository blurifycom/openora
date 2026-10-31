// Internal barrel of the betting module. The public consumer surface is the domain barrel
// (@openora/core/sportsbook), which re-exports this module's contract/ slice.
export { createSportsbookRouter } from './router/index.js';

// Random number generator seam. For dev / demo / non-certified game contexts.
//
// IMPORTANT: production game outcomes are governed by the SEALED
// `GAME_OUTCOME_AUTHORITY` token in `@oss/compliance-invariants` (regulator
// mandate - GLI / eCOGRA / BMM / iTechLabs). `RNG_ADAPTER` is NOT a substitute
// for a lab-certified RGS. Use this seam to swap deterministic mocks in tests,
// to plug in a seedable provider for replay debugging, or to back demo games
// that never resolve real money. Real-money RTP must flow through the sealed
// authority.
import { createToken, type Token } from './token.js';

export type RngAdapter = {
  /** Uniform float in [0, 1). */
  nextFloat(): number;
  /** Uniform integer in [min, maxExclusive). */
  nextInt(min: number, maxExclusive: number): number;
  /** Optional reseed. Implementations free to ignore for non-deterministic sources. */
  seed?(value: string): void;
};

export const RNG_ADAPTER: Token<RngAdapter> = createToken('RNG_ADAPTER');

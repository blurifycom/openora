import type { RngAdapter } from '@oss/adapters';

/**
 * Deterministic, seedable mulberry32 RNG. Default seed is wall-clock so behavior
 * matches a non-seeded source out of the box; `seed()` switches to deterministic
 * mode for replay debugging / tests.
 *
 * NOT for real-money game outcomes - those flow through the sealed
 * `GAME_OUTCOME_AUTHORITY` token (lab-certified RGS).
 */
export class MockRngAdapter implements RngAdapter {
  private state: number;

  constructor(seed?: string) {
    this.state = seed ? hashSeed(seed) : (Date.now() & 0xffffffff) >>> 0;
  }

  seed(value: string): void {
    this.state = hashSeed(value);
  }

  nextFloat(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(min: number, maxExclusive: number): number {
    if (maxExclusive <= min) {
      throw new Error(`MockRngAdapter.nextInt: maxExclusive (${maxExclusive}) must be > min (${min})`);
    }
    return min + Math.floor(this.nextFloat() * (maxExclusive - min));
  }
}

function hashSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

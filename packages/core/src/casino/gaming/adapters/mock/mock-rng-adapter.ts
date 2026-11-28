import type { RngAdapter } from '@openora/core/contracts';

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
      throw new Error(
        `MockRngAdapter.nextInt: maxExclusive (${maxExclusive}) must be > min (${min})`,
      );
    }
    return min + Math.floor(this.nextFloat() * (maxExclusive - min));
  }
}

export function hashSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

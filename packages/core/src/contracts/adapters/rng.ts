import { createToken, type Token } from './token.js';

export type RngAdapter = {
  nextFloat(): number;
  nextInt(min: number, maxExclusive: number): number;
  seed?(value: string): void;
};

export const RNG_ADAPTER: Token<RngAdapter> = createToken('RNG_ADAPTER');

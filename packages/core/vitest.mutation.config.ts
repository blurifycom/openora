import { defineConfig, mergeConfig } from 'vitest/config';
import integration from './vitest.integration.config';

// Stryker runs one vitest per mutant, so both tiers go into one config: a mutant only a unit
// test catches (the HMAC verifier) counts as killed instead of uncovered.
export default mergeConfig(
  integration,
  defineConfig({ test: { include: ['src/**/*.{test,spec}.ts'] } }),
);

import { SEALED_TOKENS } from './sealed.js';

/**
 * Runtime assertion that the assembled DI container has not bound any sealed
 * service token to a non-default provider. Operators run this in their CI
 * suite against their assembled app to catch regressions where a plugin tried
 * (in plain JS) to slip past the typed contract.
 *
 * The argument shape is intentionally minimal - any container exposing a
 * boolean `has(token)` works. `@oss/core` `Container.has(token)` satisfies it.
 *
 * Throws on first sealed token with a bound provider, listing the offender.
 */
export type SealedContainerView = {
  has(token: symbol): boolean;
};

export function assertNoSealedProviders(container: SealedContainerView): void {
  const violations: string[] = [];
  for (const token of SEALED_TOKENS) {
    if (container.has(token)) {
      violations.push(token.description ?? '(unnamed)');
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `[compliance-invariants] sealed services must not be bound by a plugin:\n` +
        violations.map((v) => `  - ${v}`).join('\n') +
        `\nSee @oss/compliance-invariants/sealed.ts for the regulatory citations.`,
    );
  }
}

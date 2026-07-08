import { IMPLEMENTED_SEALED_TOKENS } from './sealed.js';

/**
 * Runtime assertion that every sealed service the platform actually implements
 * (`IMPLEMENTED_SEALED_TOKENS`) is bound in the assembled DI container. Operators
 * run this in their CI suite against their assembled app to catch a
 * misconfigured deployment where a regulator-mandated service's owning module
 * was never loaded (eg the audit module disabled, silently dropping every
 * audit write).
 *
 * A sealed token can only ever be bound once, by its owning module, via
 * `ctx.provideSealed()` - `ctx.provide()` rejects any sealed token outright and
 * `provideSealed()` itself refuses a second bind (see module-registry.ts). So a
 * bound sealed token is always the owner's canonical implementation, never a
 * plugin override; this check exists to catch an ABSENT binding, not a hijacked
 * one - the hijack path is already closed at bind time for every deployment.
 *
 * The argument shape is intentionally minimal - any container exposing a
 * boolean `has(token)` works. `@openora/core/server` `Container.has(token)` satisfies it.
 *
 * Throws listing every sealed service that isn't bound.
 */
export type SealedContainerView = {
  has(token: symbol): boolean;
};

export function assertSealedServicesBound(container: SealedContainerView): void {
  const missing: string[] = [];
  for (const token of IMPLEMENTED_SEALED_TOKENS) {
    if (!container.has(token)) {
      missing.push(token.description ?? '(unnamed)');
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[compliance-invariants] sealed services must be bound by their owning module:\n` +
        missing.map((v) => `  - ${v}`).join('\n') +
        `\nSee @openora/core/compliance/sealed.ts for the regulatory citations.`,
    );
  }
}

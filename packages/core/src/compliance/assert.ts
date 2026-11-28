import { IMPLEMENTED_SEALED_TOKENS } from './sealed.js';

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

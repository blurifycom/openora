// Typed DI token. A token is a plain Symbol at runtime; the phantom `__token`
// field only carries the resolved type so the composition container can infer
// what `container.get(TOKEN)` returns. No decorators, no reflection - the type
// travels with the symbol. See @blurifycom/core/server `Container`.

// The `__sealed?: never` brand makes Token<T> structurally incompatible with
// SealedToken<T> (which has `__sealed: true`). That mismatch is what lets the
// `provide<T>(token: Token<T>, ...)` signature reject sealed tokens at the
// call site - see SealedToken below.
export type Token<T> = symbol & { readonly __token?: T; readonly __sealed?: never };

export function createToken<T>(description: string): Token<T> {
  return Symbol(description) as Token<T>;
}

/**
 * A sealed token represents a regulator-mandated service operators must NEVER
 * override (self-exclusion enforcement, AML/SAR audit log writes, ledger writes,
 * RNG/game outcomes, etc.). Note KYC status writes are NOT sealed: they need a
 * concrete pam-bound implementation, so `KYC_STATUS_WRITER` is a regular Token
 * whose single-writer invariant is enforced structurally (see its doc in kyc.ts).
 *
 * Structurally distinct from `Token<T>` via the `__sealed` brand, so
 * `ctx.provide(token, factory)` - typed `<T>(token: Token<T>, ...)` - will
 * reject a `SealedToken<T>` at the call site with a TypeScript error.
 *
 * Belt-and-braces: the plugin host also runtime-checks token identity against
 * the sealed list at registration time.
 *
 * See `@blurifycom/core/compliance` for the canonical list and the regulatory
 * citation per token.
 */
export type SealedToken<T> = symbol & {
  readonly __token?: T;
  readonly __sealed: true;
};

export function createSealedToken<T>(description: string): SealedToken<T> {
  return Symbol(`sealed:${description}`) as SealedToken<T>;
}

/**
 * A page override token lets a plugin replace an entire client-side page
 * via `ctx.provide(ADMIN_USERS_PAGE, MyImpl)`. The phantom type tracks the
 * page component shape so the swap is type-checked.
 *
 * This is the Tier 3 escape hatch from the extensibility tier model
 * (see ADR-0013). For most extension needs prefer Tier 1 (slots) or
 * Tier 2 (block composition).
 */
export type ClientPageToken<P = unknown> = symbol & {
  readonly __token?: P;
  readonly __clientPage: true;
};

export function createClientPageToken<P = unknown>(description: string): ClientPageToken<P> {
  return Symbol(`page:${description}`) as ClientPageToken<P>;
}

// Typed DI token. A token is a plain Symbol at runtime; the phantom `__token`
// field only carries the resolved type so the composition container can infer
// what `container.get(TOKEN)` returns. No decorators, no reflection - the type
// travels with the symbol. See @openora/core/server `Container`.

// Common shape both Token and SealedToken share - what Container itself accepts.
// Container is a type-erased-at-runtime symbol map; it doesn't care whether a
// token is sealed, only ModuleRegistry.provide()/provideSealed() do.
export type AnyToken<T, K extends string = string> = symbol & {
  readonly __token?: T;
  readonly __key?: K;
};

export type TokenCatalogValues = Record<string, unknown>;

export type TokenCatalog<Values extends TokenCatalogValues = TokenCatalogValues> = {
  [K in keyof Values]: AnyToken<Values[K]>;
};

export type TokenValue<T> = T extends AnyToken<infer Value> ? Value : never;

// The `__sealed?: never` brand makes Token<T> structurally incompatible with
// SealedToken<T> (which has `__sealed: true`). That mismatch is what lets the
// `provide<T>(token: Token<T>, ...)` signature reject sealed tokens at the
// call site - see SealedToken below.
export type Token<T, K extends string = string> = AnyToken<T, K> & {
  readonly __sealed?: never;
};

export function createToken<T, const K extends string = string>(key: K): Token<T, K> {
  return Symbol(key) as Token<T, K>;
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
 * See `@openora/core/compliance` for the canonical list and the regulatory
 * citation per token.
 */
export type SealedToken<T, K extends string = string> = AnyToken<T, K> & {
  readonly __sealed: true;
};

export function createSealedToken<T, const K extends string = string>(key: K): SealedToken<T, K> {
  return Symbol(`sealed:${key}`) as SealedToken<T, K>;
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
